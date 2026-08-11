// The queue is what stops one expensive search from taking the whole service
// down with it. These tests pin the three properties the design depends on.
import { describe, expect, it } from "vitest";

import {
  EngineQueue,
  QueueCancelledError,
  QueueFullError,
  QueueWaitTimeoutError,
  type QueuePosition,
} from "../src/queue.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("concurrency", () => {
  it("serialises on a single CPU: one runs, the rest queue", async () => {
    // The exact shape the brief names. Three jobs, concurrency 1: A runs, B and
    // C wait. Three engine processes fighting over one core is the failure this
    // prevents.
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 10 });
    let running = 0;
    let peak = 0;
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];

    const jobs = gates.map((gate, index) =>
      queue.submit({
        key: `job-${index}`,
        priority: 0,
        run: async () => {
          running += 1;
          peak = Math.max(peak, running);
          await gate.promise;
          running -= 1;
        },
      }),
    );

    await tick();
    expect(peak).toBe(1);
    expect(queue.stats()).toMatchObject({ running: 1, waiting: 2, concurrency: 1 });

    gates[0]?.resolve();
    await tick();
    expect(queue.stats()).toMatchObject({ running: 1, waiting: 1 });

    gates.forEach((gate) => gate.resolve());
    await Promise.all(jobs);
    expect(peak).toBe(1);
    expect(queue.stats()).toMatchObject({ running: 0, waiting: 0 });
  });

  it("never runs more searches at once than it is allowed to", async () => {
    const queue = new EngineQueue({ concurrency: 2, maxWaiting: 10 });
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 5 }, () => deferred<string>());

    const jobs = gates.map((gate, index) =>
      queue.submit({
        key: `job-${index}`,
        priority: 0,
        run: async () => {
          running += 1;
          peak = Math.max(peak, running);
          const value = await gate.promise;
          running -= 1;
          return value;
        },
      }),
    );

    await tick();
    expect(peak).toBe(2);
    gates.forEach((gate, index) => gate.resolve(`done-${index}`));
    await Promise.all(jobs);
    expect(peak).toBe(2);
  });
});

describe("priority", () => {
  it("runs a bot turn ahead of analysis that was queued first", async () => {
    // The property that makes "analysis never starves gameplay" true rather
    // than aspirational.
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 10 });
    const order: string[] = [];
    const blocker = deferred<void>();

    const first = queue.submit({
      key: "occupier",
      priority: 0,
      run: async () => {
        order.push("occupier");
        await blocker.promise;
      },
    });
    await tick();

    const analysis = queue.submit({
      key: "analysis",
      priority: 40,
      run: async () => {
        order.push("analysis");
      },
    });
    const bot = queue.submit({
      key: "bot",
      priority: 0,
      run: async () => {
        order.push("bot");
      },
    });

    blocker.resolve();
    await Promise.all([first, analysis, bot]);
    expect(order).toEqual(["occupier", "bot", "analysis"]);
  });

  it("keeps arrival order within one priority", async () => {
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 10 });
    const order: number[] = [];
    const blocker = deferred<void>();
    const occupier = queue.submit({
      key: "occupier",
      priority: 0,
      run: async () => {
        await blocker.promise;
      },
    });
    await tick();

    const jobs = [1, 2, 3].map((index) =>
      queue.submit({
        key: `job-${index}`,
        priority: 20,
        run: async () => {
          order.push(index);
        },
      }),
    );
    blocker.resolve();
    await Promise.all([occupier, ...jobs]);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("admission", () => {
  it("refuses work rather than accepting it into a queue it cannot serve", async () => {
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 2 });
    const blocker = deferred<void>();
    const accepted = [0, 1, 2].map((index) =>
      queue.submit({
        key: `job-${index}`,
        priority: 0,
        run: async () => {
          await blocker.promise;
        },
      }),
    );
    await expect(
      queue.submit({ key: "overflow", priority: 0, run: async () => undefined }),
    ).rejects.toBeInstanceOf(QueueFullError);
    blocker.resolve();
    await Promise.all(accepted);
  });
});

describe("deduplication", () => {
  it("runs identical work once and answers every caller", async () => {
    const queue = new EngineQueue({ concurrency: 2, maxWaiting: 10 });
    let runs = 0;
    const gate = deferred<string>();
    const task = () => ({
      key: "same",
      priority: 0,
      run: async () => {
        runs += 1;
        return gate.promise;
      },
    });

    const callers = [queue.submit(task()), queue.submit(task()), queue.submit(task())];
    await tick();
    gate.resolve("answer");
    expect(await Promise.all(callers)).toEqual(["answer", "answer", "answer"]);
    expect(runs).toBe(1);
  });
});

describe("cancellation", () => {
  it("stops the search when the last interested caller goes away", async () => {
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 10 });
    const controller = new AbortController();
    let observed: AbortSignal | undefined;

    const job = queue.submit(
      {
        key: "cancel-me",
        priority: 0,
        run: (signal) =>
          new Promise((_resolve, reject) => {
            observed = signal;
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      },
      controller.signal,
    );

    await tick();
    controller.abort();
    await expect(job).rejects.toThrow("aborted");
    expect(observed?.aborted).toBe(true);
  });

  it("keeps running while another caller is still waiting on the same work", async () => {
    // One player closing a tab must not cancel the search their opponent — or
    // their own second tab — is still watching. Only the LAST reference
    // cancels.
    //
    // The departing caller's promise still settles with the shared result: it
    // is the same promise, and there is nobody left on that end to receive it.
    // What matters is that the run was not interrupted.
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 10 });
    const leaving = new AbortController();
    const gate = deferred<string>();
    let interrupted = false;

    const task = () => ({
      key: "shared",
      priority: 0,
      run: (signal: AbortSignal) =>
        new Promise<string>((resolve, reject) => {
          signal.addEventListener("abort", () => {
            interrupted = true;
            reject(new Error("aborted"));
          });
          void gate.promise.then(resolve);
        }),
    });

    const departing = queue.submit(task(), leaving.signal);
    const staying = queue.submit(task());
    await tick();

    leaving.abort();
    await tick();
    expect(interrupted).toBe(false);

    gate.resolve("finished");
    await expect(staying).resolves.toBe("finished");
    await expect(departing).resolves.toBe("finished");
  });

  it("gives a cancelled job's place back at once instead of at its turn", async () => {
    // Capacity has to be released when work stops being WANTED, not when the
    // queue eventually gets round to it. A burst of disconnects otherwise
    // leaves a queue full of jobs nobody is waiting for, refusing live work.
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 2 });
    const blocker = deferred<void>();
    const leaving = new AbortController();

    const occupier = queue.submit({
      key: "occupier",
      priority: 0,
      run: async () => {
        await blocker.promise;
      },
    });
    await tick();

    let started = false;
    const abandoned = queue.submit(
      {
        key: "abandoned",
        priority: 0,
        run: async () => {
          started = true;
        },
      },
      leaving.signal,
    );
    expect(queue.stats().waiting).toBe(1);

    leaving.abort();
    await expect(abandoned).rejects.toBeInstanceOf(QueueCancelledError);
    // Freed immediately, and the process was never spawned at all.
    expect(queue.stats().waiting).toBe(0);
    expect(started).toBe(false);

    // The place it gave up is usable by someone else.
    const replacement = queue.submit({
      key: "replacement",
      priority: 0,
      run: async () => "ok",
    });
    expect(queue.stats().waiting).toBe(1);

    blocker.resolve();
    await occupier;
    await expect(replacement).resolves.toBe("ok");
  });

  it("frees the running slot when a search fails", async () => {
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 4 });
    await expect(
      queue.submit({
        key: "explodes",
        priority: 0,
        run: async () => {
          throw new Error("engine died");
        },
      }),
    ).rejects.toThrow("engine died");
    await tick();
    expect(queue.stats()).toMatchObject({ running: 0, waiting: 0 });

    await expect(
      queue.submit({ key: "after", priority: 0, run: async () => "ok" }),
    ).resolves.toBe("ok");
  });

  it("frees the running slot when a job throws before it returns a promise", async () => {
    // A synchronous throw out of `run` used to leave the running count high
    // forever, shrinking the pool by one on every occurrence until nothing
    // could run at all.
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 4 });
    await expect(
      queue.submit({
        key: "throws-sync",
        priority: 0,
        run: () => {
          throw new Error("bad binary path");
        },
      }),
    ).rejects.toThrow("bad binary path");
    await tick();
    expect(queue.stats().running).toBe(0);
    await expect(queue.submit({ key: "after", priority: 0, run: async () => "ok" })).resolves.toBe(
      "ok",
    );
  });

  it("frees the running slot when a search is cancelled mid-flight", async () => {
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 4 });
    const controller = new AbortController();
    const job = queue.submit(
      {
        key: "long",
        priority: 0,
        run: (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("killed")));
          }),
      },
      controller.signal,
    );
    await tick();
    expect(queue.stats().running).toBe(1);
    controller.abort();
    await expect(job).rejects.toThrow("killed");
    await tick();
    expect(queue.stats().running).toBe(0);
  });
});

describe("the wait deadline", () => {
  it("refuses a job the queue will not reach in a useful amount of time", async () => {
    // Depth alone does not bound the wait: at concurrency 1 a queue of eight
    // `max` searches is forty minutes. A refusal the caller can retry beats an
    // acceptance it will abandon.
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 8, maxWaitMs: 20 });
    const blocker = deferred<void>();
    const occupier = queue.submit({
      key: "occupier",
      priority: 0,
      run: async () => {
        await blocker.promise;
      },
    });
    await tick();

    let started = false;
    const waiting = queue.submit({
      key: "waits-too-long",
      priority: 0,
      run: async () => {
        started = true;
      },
    });

    await expect(waiting).rejects.toBeInstanceOf(QueueWaitTimeoutError);
    expect(started).toBe(false);
    expect(queue.stats().waiting).toBe(0);

    blocker.resolve();
    await occupier;
  });

  it("does not apply the deadline once a job is running", async () => {
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 4, maxWaitMs: 20 });
    const gate = deferred<string>();
    const job = queue.submit({ key: "slow", priority: 0, run: () => gate.promise });
    await new Promise((resolve) => setTimeout(resolve, 60));
    gate.resolve("finished anyway");
    await expect(job).resolves.toBe("finished anyway");
  });
});

describe("lifecycle reporting", () => {
  it("says nothing about queueing for a job that started immediately", async () => {
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 4 });
    const events: string[] = [];
    await queue.submit({ key: "solo", priority: 0, run: async () => "done" }, undefined, {
      onQueued: () => events.push("queued"),
      onStart: () => events.push("start"),
    });
    expect(events).toEqual(["start"]);
  });

  it("reports queued, then running, in that order", async () => {
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 4 });
    const blocker = deferred<void>();
    const occupier = queue.submit({
      key: "occupier",
      priority: 0,
      run: async () => {
        await blocker.promise;
      },
    });
    await tick();

    const events: string[] = [];
    const job = queue.submit({ key: "second", priority: 0, run: async () => "done" }, undefined, {
      onQueued: () => events.push("queued"),
      onStart: () => events.push("start"),
    });
    expect(events).toEqual(["queued"]);

    blocker.resolve();
    await Promise.all([occupier, job]);
    expect(events).toEqual(["queued", "start"]);
  });

  it("reports a place in line that is a fact, and updates it as the line moves", async () => {
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 8 });
    const blocker = deferred<void>();
    const gateB = deferred<void>();
    const occupier = queue.submit({
      key: "occupier",
      priority: 0,
      run: async () => {
        await blocker.promise;
      },
    });
    await tick();

    const seenB: QueuePosition[] = [];
    const seenC: QueuePosition[] = [];
    const jobB = queue.submit(
      {
        key: "b",
        priority: 10,
        run: async () => {
          await gateB.promise;
        },
      },
      undefined,
      { onQueued: (at) => seenB.push(at), onPosition: (at) => seenB.push(at) },
    );
    const jobC = queue.submit({ key: "c", priority: 10, run: async () => undefined }, undefined, {
      onQueued: (at) => seenC.push(at),
      onPosition: (at) => seenC.push(at),
    });

    // B is next; C is behind it.
    expect(seenB[0]).toEqual({ ahead: 0, position: 1 });
    expect(seenC[0]).toEqual({ ahead: 1, position: 2 });

    blocker.resolve();
    await tick();
    // B started, so C moved up — and was told so rather than being left showing
    // a number that had stopped being true.
    expect(seenC.at(-1)).toEqual({ ahead: 0, position: 1 });

    gateB.resolve();
    await Promise.all([occupier, jobB, jobC]);
  });

  it("tells a bot turn it jumped the analysis queue, honestly", async () => {
    // The count is a snapshot, and a bot turn arriving later legitimately
    // overtakes. What must never happen is a queued caller being left with a
    // stale number: every change is reported.
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 8 });
    const blocker = deferred<void>();
    const occupier = queue.submit({
      key: "occupier",
      priority: 0,
      run: async () => {
        await blocker.promise;
      },
    });
    await tick();

    const analysisSeen: QueuePosition[] = [];
    const analysis = queue.submit(
      { key: "analysis", priority: 40, run: async () => undefined },
      undefined,
      { onQueued: (at) => analysisSeen.push(at), onPosition: (at) => analysisSeen.push(at) },
    );
    expect(analysisSeen.at(-1)).toEqual({ ahead: 0, position: 1 });

    const botSeen: QueuePosition[] = [];
    const bot = queue.submit({ key: "bot", priority: 0, run: async () => undefined }, undefined, {
      onQueued: (at) => botSeen.push(at),
      onPosition: (at) => botSeen.push(at),
    });

    // The bot outranks the analysis, so it is first and the analysis is told it
    // slipped to second.
    expect(botSeen.at(-1)).toEqual({ ahead: 0, position: 1 });
    expect(analysisSeen.at(-1)).toEqual({ ahead: 1, position: 2 });

    blocker.resolve();
    await Promise.all([occupier, analysis, bot]);
  });

  it("tells a caller joining an existing run where that run already is", async () => {
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 4 });
    const gate = deferred<string>();
    const first = queue.submit({ key: "shared", priority: 0, run: () => gate.promise });
    await tick();

    const events: string[] = [];
    const second = queue.submit({ key: "shared", priority: 0, run: () => gate.promise }, undefined, {
      onQueued: () => events.push("queued"),
      onStart: () => events.push("start"),
    });
    // Already running when the second caller arrived, so it hears "start", not
    // silence and not a fictional queue position.
    expect(events).toEqual(["start"]);

    gate.resolve("answer");
    expect(await Promise.all([first, second])).toEqual(["answer", "answer"]);
  });
});

describe("starvation", () => {
  it("never lets analysis load delay a bot turn past the next free slot", async () => {
    // Three analyses are queued ahead of a bot turn on a one-CPU instance. The
    // bot must run at the very next slot, not fourth.
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 10 });
    const order: string[] = [];
    const blocker = deferred<void>();

    const running = queue.submit({
      key: "analysis-a",
      priority: 10,
      run: async () => {
        order.push("analysis-a");
        await blocker.promise;
      },
    });
    await tick();

    const queued = ["analysis-b", "analysis-c", "analysis-d"].map((key) =>
      queue.submit({
        key,
        priority: 10,
        run: async () => {
          order.push(key);
        },
      }),
    );
    const bot = queue.submit({
      key: "bot",
      priority: 0,
      run: async () => {
        order.push("bot");
      },
    });

    blocker.resolve();
    await Promise.all([running, bot, ...queued]);
    // The running analysis was not killed — preemption is not something this
    // architecture can do safely — but nothing queued got ahead of gameplay.
    expect(order).toEqual(["analysis-a", "bot", "analysis-b", "analysis-c", "analysis-d"]);
  });
});
