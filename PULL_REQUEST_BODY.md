### Summary

Prepare creator-copilot-service for publishing to GitHub Packages.

### Changes

- Add scoped package name and publishConfig; remove `private` so `npm publish` is allowed.
- Added package-lock.json to ensure reproducible installs.

### Files changed
- `creator-copilot-service/package.json`
- `creator-copilot-service/package-lock.json`

### Notes & checklist
- [ ] Confirm package scope `@bosscandy123` is correct for the account
- [ ] Confirm removing `private` is intended so this package can be published
- [ ] Confirm repository Actions / org settings allow GITHUB_TOKEN to publish packages

### Testing steps
1. Create a release with a tag that matches `package.json` version (0.1.0)
2. Confirm CI runs and publish step executes successfully

---

