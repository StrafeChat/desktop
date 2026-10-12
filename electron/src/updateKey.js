// The public half of the release signing key: an update installs only if its file verifies
// against this. The same key the Tauri shell carries (src-tauri/tauri.conf.json,
// plugins.updater.pubkey, base64 of the minisign key file), so one signed release feeds both
// shells; test/updater.test.js fails if the two ever differ.
//
// Changing it means every installed copy stops accepting updates signed with the old key.

module.exports = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDNFMzFDQUJBRUREMzdCRTEKUldUaGU5UHR1c294UHRMUUZHNjEyNUtpWnFSOUUrdnYzaUpWaHA3VjZRWHBINEljZytvV2tCZ1gK';
