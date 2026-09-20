-- Run this script against the default "postgres" database with psql.
-- It is safe to run repeatedly.
SELECT 'CREATE DATABASE model_access'
WHERE NOT EXISTS (
    SELECT FROM pg_database WHERE datname = 'model_access'
)\gexec
