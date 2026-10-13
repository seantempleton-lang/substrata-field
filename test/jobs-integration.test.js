const test = require("node:test");
const assert = require("node:assert/strict");
const { handleJobsIntegration, authorized } = require("../jobs-integration");

test("Jobs service key permits only the dedicated point read endpoint", async () => {
  process.env.FIELD_JOBS_KEY = "test-server-only-key";
  assert.equal(authorized("wrong"), false);
  assert.equal(authorized("test-server-only-key"), true);
  const api = { error: (statusCode, message) => Object.assign(new Error(message), { statusCode }), points: async () => [{ POINT_ID:"BH1" }], send: (_res, _status, body) => { assert.equal(body[0].POINT_ID,"BH1"); } };
  await assert.rejects(handleJobsIntegration({ method:"GET", headers:{} }, {}, new URL("http://localhost/api/jobs/points?proj_id=1"), api), { statusCode:403 });
  assert.equal(await handleJobsIntegration({ method:"GET", headers:{ "x-jobs-key":"test-server-only-key" } }, {}, new URL("http://localhost/api/jobs/points?proj_id=1"), api), true);
  assert.equal(await handleJobsIntegration({ method:"POST", headers:{ "x-jobs-key":"test-server-only-key" } }, {}, new URL("http://localhost/api/points"), api), false);
});

test("handoff uses the authenticated employee identity and rechecks the Field point", async () => {
  process.env.FIELD_JOBS_KEY = "test-server-only-key";
  process.env.JOBS_API_URL = "http://jobs.internal";
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url.href,"http://jobs.internal/api/v1/field-handoffs/consume");
    assert.equal(JSON.parse(options.body).employeeCode,"EMP-1");
    return { ok:true, json: async () => ({ user:{ employeeCode:"EMP-1" }, PROJ_ID:"302670", POINT_ID:"BH1", dailyLogId:"daily-log" }) };
  };
  try {
    const api = { error:(statusCode,message) => Object.assign(new Error(message),{ statusCode }),
      auth:async () => ({ user:{ employeeCode:"EMP-1" } }), body:async () => ({ token:"token", employeeCode:"attacker" }),
      points:async project => { assert.equal(project,"302670"); return [{ POINT_ID:"BH1" }]; },
      send:(_res,_status,result) => { assert.equal(result.context.dailyLogId,"daily-log"); assert.equal(result.point.POINT_ID,"BH1"); } };
    assert.equal(await handleJobsIntegration({ method:"POST" }, {}, new URL("http://localhost/api/jobs/handoff"), api),true);
    await assert.rejects(handleJobsIntegration({ method:"POST" }, {}, new URL("http://localhost/api/jobs/handoff"), { ...api, auth:async () => { throw api.error(401,"Sign in"); } }), { statusCode:401 });
  } finally { global.fetch = originalFetch; }
});
