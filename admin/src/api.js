// Thin fetch wrapper for /api/admin. Same-origin; the `ihc_session` cookie rides along.
export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `HTTP ${status}`);
    this.status = status;
    this.body = body;
    this.errors = body && body.errors;
  }
}

export async function api(method, path, body, opts = {}) {
  const init = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch('/api/admin' + path, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { error: text }; }
  if (!res.ok) {
    if (res.status === 401 && !opts.noRedirect && typeof window !== 'undefined' && !location.pathname.endsWith('/login')) {
      window.dispatchEvent(new CustomEvent('ihc:unauthorized'));
    }
    throw new ApiError(res.status, json);
  }
  return json;
}

export const get = (p) => api('GET', p);
export const post = (p, b) => api('POST', p, b);
export const put = (p, b) => api('PUT', p, b);
export const patch = (p, b) => api('PATCH', p, b);
export const del = (p) => api('DELETE', p);

// Upload with progress (XMLHttpRequest — fetch has no upload progress). onProgress(0..1).
export function upload(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/admin' + path);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    if (xhr.upload && onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onerror = () => reject(new ApiError(0, { error: 'network error' }));
    xhr.onload = () => {
      let json = null;
      try { json = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { json = { error: xhr.responseText }; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(json);
      else {
        if (xhr.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('ihc:unauthorized'));
        reject(new ApiError(xhr.status, json));
      }
    };
    xhr.send(formData);
  });
}
