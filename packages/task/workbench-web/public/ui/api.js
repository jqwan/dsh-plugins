export async function api(apiPath, options = {}) {
  const init = { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetch('/workbench/api' + apiPath, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}
