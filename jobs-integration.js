const { timingSafeEqual } = require("crypto");

function authorized(value) {
  const expected = process.env.FIELD_JOBS_KEY;
  if (!expected || !value) return false;
  const a = Buffer.from(expected), b = Buffer.from(value);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handleJobsIntegration(req, res, url, api) {
  if (url.pathname === "/api/jobs/points" && req.method === "GET") {
    if (!authorized(req.headers["x-jobs-key"])) throw api.error(403, "Jobs service authentication is required");
    const project = url.searchParams.get("proj_id");
    if (!project) throw api.error(400, "proj_id is required");
    api.send(res, 200, await api.points(project));
    return true;
  }
  if (url.pathname === "/api/jobs/handoff" && req.method === "POST") {
    const session = await api.auth(req, res);
    if (!process.env.JOBS_API_URL || !process.env.FIELD_JOBS_KEY) throw api.error(503, "Jobs handoff is not configured");
    const body = await api.body(req);
    const response = await fetch(new URL("/api/v1/field-handoffs/consume", process.env.JOBS_API_URL), {
      method: "POST", headers: { "Content-Type": "application/json", "X-Jobs-Key": process.env.FIELD_JOBS_KEY },
      body: JSON.stringify({ token: body.token, employeeCode: session.user.employeeCode }), signal: AbortSignal.timeout(10000), redirect: "error",
    });
    if (!response.ok) throw api.error(response.status === 403 ? 403 : 502, "Jobs handoff is expired, already used, or unavailable");
    const context = await response.json();
    if (context.user.employeeCode !== session.user.employeeCode) throw api.error(403, "This handoff belongs to another employee");
    const points = context.POINT_ID ? await api.points(context.PROJ_ID) : [];
    if (context.POINT_ID && !points.some(p => p.POINT_ID === context.POINT_ID)) throw api.error(404, "Field point no longer exists");
    api.send(res, 200, { context, point: points.find(p => p.POINT_ID === context.POINT_ID) || null });
    return true;
  }
  return false;
}
module.exports = { handleJobsIntegration, authorized };
