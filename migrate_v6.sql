-- Migration v6: encryption public keys + unlimited sessions already handled in PHP
ALTER TABLE users ADD COLUMN crypto_public_key TEXT DEFAULT NULL AFTER avatar_path;
