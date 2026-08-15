export function getDatabaseUrl() {
  const projectRef = process.env.SIA_HUAT_PROJECT_REF;
  const password = process.env.SIA_HUAT_POSTGRES_PASSWORD;
  if (projectRef && password) return `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=no-verify`;
  const fallback = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
  if (!fallback) throw new Error("Database connection is missing");
  return fallback.replace(/sslmode=[^&]+/, "sslmode=no-verify");
}
