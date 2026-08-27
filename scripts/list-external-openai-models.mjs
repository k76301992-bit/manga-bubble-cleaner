const baseUrl = (process.env.EXTERNAL_OPENAI_BASE_URL ?? "https://ggg-production-739f.up.railway.app/v1").replace(/\/$/, "");
const apiKey = process.env.EXTERNAL_OPENAI_API_KEY;

const headers = { Accept: "application/json" };
if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

const response = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(20_000) });
const body = await response.text();
if (!response.ok) {
  console.error(JSON.stringify({ ok: false, status: response.status, body: body.slice(0, 600) }, null, 2));
  process.exitCode = 1;
} else {
  const payload = JSON.parse(body);
  const models = Array.isArray(payload.data) ? payload.data : [];
  console.log(JSON.stringify({ ok: true, baseUrl, modelCount: models.length, models: models.map((model) => ({ id: model.id, owned_by: model.owned_by ?? null })) }, null, 2));
}
