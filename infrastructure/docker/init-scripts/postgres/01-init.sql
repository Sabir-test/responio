-- Responio PostgreSQL Initialization
-- Runs once when the PostgreSQL container is first created.

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";          -- pgvector for RAG embeddings
CREATE EXTENSION IF NOT EXISTS "pg_trgm";         -- BM25 hybrid search
CREATE EXTENSION IF NOT EXISTS "pgcrypto";        -- gen_random_uuid(), encryption helpers

-- Create application user (restricted, used by services)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'responio_app') THEN
    CREATE ROLE responio_app WITH LOGIN PASSWORD 'app_password_set_via_env';
  END IF;
END
$$;

-- Create admin user (bypasses RLS — billing, admin operations only)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'responio_admin') THEN
    CREATE ROLE responio_admin WITH LOGIN PASSWORD 'admin_password_set_via_env' BYPASSRLS;
  END IF;
END
$$;

-- Grant privileges
GRANT CONNECT ON DATABASE responio_development TO responio_app;
GRANT CONNECT ON DATABASE responio_development TO responio_admin;
GRANT USAGE ON SCHEMA public TO responio_app;
GRANT USAGE ON SCHEMA public TO responio_admin;
