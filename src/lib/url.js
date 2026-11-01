// Prefixes an internal path with the deploy base (`/` in production,
// `/jennymakunas.com/` on the project-site preview).
const base = import.meta.env.BASE_URL;

export const url = (p) => {
  const s = String(p ?? '');
  if (/^(https?:|mailto:|tel:|#|data:)/.test(s)) return s;
  return `${base.replace(/\/$/, '')}${s.startsWith('/') ? '' : '/'}${s}`;
};
