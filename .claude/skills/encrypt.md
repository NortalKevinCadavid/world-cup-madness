# Encrypt Secrets

Encrypt all plaintext secrets in `secrets/plain/` to `secrets/enc/` using age.

## Steps

1. Check that prerequisites are met:
   - `age` is installed: `age --version`
   - Keys exist: `ls ~/.keys/age/keys.txt`
   - Recipients configured: `cat secrets/recipients.txt` (must not be empty)
   - Plaintext secrets exist: `ls secrets/plain/` (should have files beyond .gitkeep)

2. Run encryption:
   ```bash
   ./scripts/secrets/encrypt_all.sh
   ```

3. Verify the results:
   - Check that `.age` files exist in `secrets/enc/`
   - Check that `secrets/manifest.json` was updated

4. Suggest the user commit the encrypted files:
   ```bash
   git add secrets/enc/ secrets/manifest.json
   git commit -m "Update encrypted secrets"
   ```

5. **NEVER** read or display the contents of files in `secrets/plain/`.
