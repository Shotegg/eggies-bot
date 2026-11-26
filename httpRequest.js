const DEFAULT_TIMEOUT_MS = 15000;

// Only retry safe reads. A failed redemption POST may already have succeeded remotely.
async function requestBody(url, options = {}, { format = 'json', attempts = 1, timeoutMs = DEFAULT_TIMEOUT_MS, allowHttpError = false } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok && !allowHttpError) {
        const error = new Error(`HTTP ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      const data = format === 'text' ? await response.text() : await response.json();
      return { response, data };
    } catch (error) {
      if (attempt === attempts || error.retryable === false || (error.retryable === undefined && error instanceof SyntaxError)) throw error;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }
}

module.exports = { requestBody };
