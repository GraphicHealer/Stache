export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req(path: string, init?: RequestInit) {
  const res = await fetch(path, init);
  if (res.status === 401 && !path.startsWith('/api/auth')) {
    window.dispatchEvent(new Event('stash:unauth'));
  }
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const body = await res.json();
      msg = body.message ?? msg;
    } catch {
      /* non-json error */
    }
    throw new ApiError(res.status, msg);
  }
  return res.json();
}

const json = (body: unknown) => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  get: (p: string) => req(p),
  post: (p: string, body?: unknown) => req(p, { method: 'POST', ...(body !== undefined ? json(body) : {}) }),
  patch: (p: string, body: unknown) => req(p, { method: 'PATCH', ...json(body) }),
  put: (p: string, body: unknown) => req(p, { method: 'PUT', ...json(body) }),
  del: (p: string) => req(p, { method: 'DELETE' }),
  upload: (p: string, form: FormData) => req(p, { method: 'POST', body: form }),

  /** File a new item: fields + photo blobs in one multipart request. */
  fileItem(fields: Record<string, string>, blobs: Blob[]) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v) form.set(k, v);
    blobs.forEach((b, i) => form.append('photo', b, `photo-${i}.jpg`));
    return req('/api/items', { method: 'POST', body: form });
  },
};
