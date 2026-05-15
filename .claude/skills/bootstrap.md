# Bootstrap

Run first-time project setup: generate age keys, install git hooks, configure recipients, and build the initial INDEX.

## Steps

1. Check prerequisites:
   - Verify `age` is installed: `age --version`
   - Verify `git` is initialized: `git rev-parse --git-dir`
   - Verify `python3` is available: `python3 --version`

2. Run the bootstrap script:
   ```bash
   ./scripts/bootstrap.sh
   ```

3. Verify the setup completed successfully by checking:
   - Keys exist: `ls ~/.keys/age/keys.txt`
   - Hooks installed: `git config core.hooksPath`
   - Recipients configured: `cat secrets/recipients.txt`
   - INDEX.md generated: `cat INDEX.md`

4. Report the results to the user with any issues found.
