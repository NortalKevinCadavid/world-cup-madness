# Reindex

Regenerate the INDEX.md repository map after file structure changes.

## Steps

1. Run the index generator:
   ```bash
   ./scripts/index/generate.sh
   ```

2. Verify that INDEX.md was updated:
   - Check that new files/directories appear in the generated section
   - Confirm that content outside the `<!-- GENERATED:START -->` / `<!-- GENERATED:END -->` markers was preserved

3. Report what changed to the user.
