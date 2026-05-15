# Secrets Audit

Run a health check on the secrets workflow and report findings.

## Steps

1. Run the audit script:
   ```bash
   ./scripts/secrets/audit.sh
   ```

2. Interpret the results for the user:
   - **Recipients**: Are public keys configured?
   - **Plaintext**: Are there unencrypted secrets that need encrypting?
   - **Encrypted**: Do encrypted files exist and are they valid?
   - **Staleness**: Have any secrets gone more than 30 days without re-encryption?
   - **Sync**: Are there plaintext files without matching encrypted versions?

3. For any issues found, provide specific remediation:
   - Missing recipients → `age-keygen` and add key to `secrets/recipients.txt`
   - Unsynced secrets → `./scripts/secrets/encrypt_all.sh`
   - Stale secrets → re-encrypt with `./scripts/secrets/encrypt_all.sh`
   - Missing keys → `./scripts/secrets/gen_keys.sh`

4. **NEVER** read or display the contents of files in `secrets/plain/`.
