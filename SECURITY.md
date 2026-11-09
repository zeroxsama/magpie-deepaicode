# Security

## Reporting

Open an issue at https://github.com/aqiu817/magpie-deepaicode/issues (or a private
security advisory if the repository offers one). Please do not include real API keys or
credential files in reports — the probe script already masks them.

## Credential handling

| Data | Where it lives | Who can read it |
|---|---|---|
| DeepAI API key | magpie's `plugin-auth.json` (mode 0600 on POSIX) | magpie + the plugin host process |
| DeepAI desktop credential | `~/.deepai-code/userdata/secrets/deepai-account.bin` (the app's own plaintext JSON) | the user's account only |
| Per-account machine UUID | `~/.magpie-deepaicode/machines.json` (mode 0600) and the account's metadata in magpie's `plugin-auth.json` | the user's account only |

Apart from the machine-id store, nothing is written outside magpie's config directory.
The desktop credential file is opened read-only. The machine UUID is not a credential and
is never logged; deleting the store only means new UUIDs are generated for each account.

## Network boundaries

- Request URLs are **rebuilt from the configured base** (`https://api.deepai.org/deepai_code`
  by default). The host in the incoming URL is only used to decide chat vs responses; it is
  never contacted.
- Redirects are refused. An invalid key makes upstream respond `302` to its sign-in page;
  following it would turn an authentication failure into a fake `200`.
- Keys are sent as `Api-Key` — never in query strings, never in logs.
- Error messages are passed through from the vendor; plugin-generated text never includes
  key material.
- Non-streaming JSON reads are capped (1 MiB); streaming bodies are passed through without
  buffering.

## Out of scope

The plugin does not register accounts and does not accept connections from the network —
the browser sign-in helper listens on `127.0.0.1` only, on a random port, for one callback.
