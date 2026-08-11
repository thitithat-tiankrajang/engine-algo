// The queue is what stops one expensive search from taking the whole service
// down with it. These tests pin the three properties the design depends on.
import { describe, expect, it } from "vitest";

import { EngineQueue, QueueFullError } from "../src/queue.js";

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
});
