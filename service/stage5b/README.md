# Stage 5B analysis runtime

`runtime.mjs` is a Node bundle of `entry.ts` and the Stage 5B implementation in
the sibling `amath-bot-lab` project. `model.json` and `weights.bin` are copied
unchanged from `amath-bot-lab/public/models/stage5a-value/`. The service starts
one runtime process per analysis request, using the same queue, timeout, and
cancellation path as the C++ engine.

From the `amath-engine` directory, rebuild the bundle after changing the
adapter or Stage 5B source with:

```sh
../EQ-Lab/node_modules/.bin/esbuild service/stage5b/entry.ts --bundle --platform=node --format=esm --target=node22 --outfile=service/stage5b/runtime.mjs
```

The bundle and model files are included in the service Docker image. The
analysis setting `stage5b64` gives the Stage 5B deep pass up to 64 placement
candidates; it is not a 64-turn game search. Stage 5A contributes its value
estimate to that pass. Stage 5B also evaluates legal exchanges and pass using
its own configured quotas.
