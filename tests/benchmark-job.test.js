/**
 * F6: cancelling a provider benchmark really cancels it.
 *
 * The benchmark loop (background.js runBenchmarkJobLoop) keeps its own copy of the job while a
 * request is in flight. Cancelling writes status "cancelled" to storage, but the loop used to
 * save its stale copy afterwards (status "running" again) and carry on. And when a new job was
 * started before the old loop noticed, the old loop's finally{} cleared the runtime state of the
 * new job, so the new job could no longer be cancelled.
 *
 * Real service worker, fake fetch, no network and no real key.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackground, evalIn, waitFor, sleep, openAIChatResponse } = require("./helpers/extension-sandbox");

const JOB_KEY = "zehProviderBenchmarkJob";
const LAST_KEY = "zehProviderBenchmarkLast";
const ANSWER = JSON.stringify({ term: "x", short_meaning: "测试", translation: "测试" });

function backgroundWith(fetch) {
  const bg = loadBackground({
    storage: {
      zehActiveProvider: "deepseek",
      zehProviders: { deepseek: { enabled: true, apiKey: "test-key", model: "" } },
    },
    fetch,
  });
  bg.context.getBenchmarkThrottleMs = () => 0; // no pause between tasks in tests
  // every write of the job record, in order
  const jobWrites = [];
  const set = bg.local.set;
  bg.local.set = (obj, cb) => {
    if (obj && JOB_KEY in obj) jobWrites.push({ jobId: obj[JOB_KEY].jobId, status: obj[JOB_KEY].status });
    return set(obj, cb);
  };
  return { bg, jobWrites };
}

const storedJob = (bg) => bg.local.data[JOB_KEY] || null;

async function start(bg) {
  const res = await bg.dispatch({ type: "START_PROVIDER_BENCHMARK", options: { mode: "quick", providerIds: ["deepseek"] } });
  assert.equal(res.ok, true, res.error);
  return res.jobId;
}

/** fetch that never answers by itself; records each request's signal; aborts like the real fetch. */
function abortableHang(signals) {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      signals.push(init.signal);
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
}

test("F6: cancelling during an in-flight request ends the job as cancelled, not completed", async () => {
  const signals = [];
  const { bg, jobWrites } = backgroundWith(abortableHang(signals));
  const jobId = await start(bg);
  await waitFor(() => signals.length === 1, 2000, "first benchmark request");
  assert.ok(storedJob(bg).totalTasks > 1, "precondition: more than one task left");

  const res = await bg.dispatch({ type: "CANCEL_PROVIDER_BENCHMARK" });
  assert.equal(res.cancelled, true);
  assert.equal(signals[0].aborted, true, "the in-flight request was aborted");
  const cancelWrite = jobWrites.length - 1;
  assert.equal(jobWrites[cancelWrite].status, "cancelled");

  await waitFor(() => storedJob(bg)?.finishedAt, 3000, "job finished");
  await sleep(30);
  const job = storedJob(bg);
  assert.equal(job.jobId, jobId);
  assert.equal(job.status, "cancelled");
  assert.equal(bg.local.data[LAST_KEY].cancelled, true);
  assert.deepEqual(
    jobWrites.slice(cancelWrite).filter((w) => w.status !== "cancelled"),
    [],
    "nothing wrote the job back to running (or completed) after the cancel"
  );
  assert.equal(signals.length, 1, "no further requests after the cancel");
  assert.equal(evalIn(bg.context, "benchmarkJobRuntime.running"), false);
});

test("F6: an old loop finishing late does not clear or overwrite a newer job", async () => {
  let releaseOld;
  const signals = [];
  const { bg, jobWrites } = backgroundWith((url, init, n) => {
    if (n === 1) {
      // 第一个任务的请求不理会 abort，稍后才返回（慢网络 / 已在途的响应）
      signals.push(init.signal);
      return new Promise((resolve) => {
        releaseOld = () => resolve(openAIChatResponse(ANSWER));
      });
    }
    return abortableHang(signals)(url, init);
  });

  const oldId = await start(bg);
  await waitFor(() => signals.length === 1, 2000, "old job request");
  await bg.dispatch({ type: "CANCEL_PROVIDER_BENCHMARK" });
  await sleep(2); // ids are bench_<ms>
  const newId = await start(bg);
  assert.notEqual(newId, oldId);
  await waitFor(() => signals.length === 2, 2000, "new job request");

  releaseOld(); // the old loop wakes up now, with the new job already running
  await sleep(30);
  assert.equal(storedJob(bg).jobId, newId, "the old loop did not overwrite the new job");
  assert.equal(storedJob(bg).status, "running");
  const oldCancel = jobWrites.findIndex((w) => w.jobId === oldId && w.status === "cancelled");
  assert.deepEqual(
    jobWrites.slice(oldCancel + 1).filter((w) => w.jobId === oldId),
    [],
    "the old loop wrote nothing after its cancel"
  );

  // the new job can still be cancelled: its in-flight request is aborted
  const res = await bg.dispatch({ type: "CANCEL_PROVIDER_BENCHMARK" });
  assert.equal(res.cancelled, true);
  assert.equal(res.jobId, newId);
  assert.equal(signals[1].aborted, true, "new job's request aborted");
  await waitFor(() => storedJob(bg)?.finishedAt, 3000, "new job finished");
  assert.equal(storedJob(bg).jobId, newId);
  assert.equal(storedJob(bg).status, "cancelled");
});

test("F6: a job that is not cancelled still runs every task and completes", async () => {
  const { bg, jobWrites } = backgroundWith(async () => openAIChatResponse(ANSWER));
  const jobId = await start(bg);
  await waitFor(() => storedJob(bg)?.finishedAt, 5000, "job finished");
  const job = storedJob(bg);
  assert.equal(job.jobId, jobId);
  assert.equal(job.status, "completed");
  assert.equal(job.completedTasks, job.totalTasks);
  assert.equal(job.results.length, job.totalTasks);
  assert.equal(bg.fetchCalls.length, job.totalTasks);
  assert.equal(bg.local.data[LAST_KEY].cancelled, false);
  assert.ok(jobWrites.every((w) => w.jobId === jobId));
  assert.equal(evalIn(bg.context, "benchmarkJobRuntime.running"), false);
});
