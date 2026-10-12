TEST ONLY.

Fixtures for test/minisign.test.js and test/updater.test.js. The keys here are throwaway
minisign keys made with the Tauri CLI for these tests and nothing else; no build trusts them
(the release key is src/updateKey.js). Their private halves were deleted once the fixtures
were signed - the tests only verify.

  test-only.key.pub          the key the fixtures are signed with
  other-test-only.key.pub    an unrelated key, for "wrong key" tests
  update.txt(.sig)           signed with `tauri signer sign`
  update-versioned.txt(.sig) signed with `tauri signer sign --app-version 9.8.7`, so its
                             trusted comment carries version:9.8.7

To make new ones (from the desktop repository root):

  npx tauri signer generate -w electron/test/fixtures/test-only.key --ci -p ""
  npx tauri signer sign -f electron/test/fixtures/test-only.key -p "" electron/test/fixtures/update.txt
  npx tauri signer sign -f electron/test/fixtures/test-only.key -p "" --app-version 9.8.7 electron/test/fixtures/update-versioned.txt
  rm electron/test/fixtures/test-only.key

(`./strafe push` refuses *.key files, and these repositories are public.)
