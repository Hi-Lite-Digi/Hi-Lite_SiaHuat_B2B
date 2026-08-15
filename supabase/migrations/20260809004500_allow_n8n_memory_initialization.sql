-- The n8n Postgres Chat Memory node runs CREATE TABLE IF NOT EXISTS for its
-- configured history table on every initialization. PostgreSQL requires
-- CREATE on the schema even when the table already exists.
grant create on schema public to sia_huat_n8n;
