# Feishu Doc Delivery Design

Date: 2026-05-28
Status: Approved for planning

## Goal

Add a Feishu document delivery path to the `follow-builders` skill so Codex can generate an AI Builders Digest and write it into a specified Feishu cloud-docs folder. The folder should contain one document per day. Manual Codex runs and scheduled runs should share the same delivery implementation.

## Decisions

- Implement Feishu document publishing as a new `deliver.js` delivery method: `feishu_doc`.
- Use a Feishu self-built app with `app_id` and `app_secret` to obtain tenant access tokens.
- Store non-secret Feishu settings in `~/.follow-builders/config.json`.
- Store `app_secret` in `~/.follow-builders/.env`.
- Use idempotent daily publishing: if today's document already exists, update it instead of creating a duplicate.
- Convert digest Markdown into structured Feishu document blocks.
- Keep a plain-text fallback so delivery can preserve content when structured block writing fails.
- Build for personal use first, while keeping configuration and module boundaries suitable for later publication.

## Configuration

Extend the user config with a new delivery method:

```json
{
  "delivery": {
    "method": "feishu_doc",
    "feishu": {
      "appId": "cli_xxx",
      "appSecretEnv": "FEISHU_APP_SECRET",
      "folderToken": "fldcn_xxx",
      "titleTemplate": "AI Builders Digest - {{date}}",
      "timezone": "Asia/Shanghai",
      "onExisting": "update",
      "includeMetadata": true
    }
  }
}
```

Store the app secret in `~/.follow-builders/.env`:

```bash
FEISHU_APP_SECRET=...
```

Field behavior:

- `appId`: Feishu self-built app ID.
- `appSecretEnv`: environment variable name used to read the app secret. Defaults to `FEISHU_APP_SECRET`.
- `folderToken`: target Feishu cloud-docs folder token.
- `titleTemplate`: document title template. `{{date}}` expands to `YYYY-MM-DD`.
- `timezone`: timezone used to decide the daily date. Falls back to global config `timezone`, then the local system timezone.
- `onExisting`: first version supports `update`.
- `includeMetadata`: when true, prepend generated-at and source metadata to the document.

## Architecture

Keep the current digest pipeline intact:

1. `prepare-digest.js` fetches feeds, prompts, and user config.
2. Codex or the agent remixes the prepared JSON into final digest Markdown.
3. The final digest text is passed to `deliver.js`.
4. `deliver.js` dispatches based on `delivery.method`.
5. For `feishu_doc`, `deliver.js` calls a Feishu publishing module.

`deliver.js` should not contain Feishu API details. Add focused modules under `scripts/lib/`, for example:

- `scripts/lib/feishu-docs.js`: authentication, folder lookup, document create/update, and block insertion.
- `scripts/lib/markdown-to-feishu-blocks.js`: digest Markdown to Feishu block conversion.
- `scripts/lib/date-template.js`: title template expansion and timezone-aware date handling.

These modules keep the first implementation small while leaving room for a future publisher abstraction.

## Feishu API Flow

The `feishu_doc` delivery flow:

1. Read digest text from stdin, `--message`, or `--file`, matching existing `deliver.js` behavior.
2. Load `~/.follow-builders/config.json` and `~/.follow-builders/.env`.
3. Validate `delivery.feishu.appId`, app secret, and `folderToken`.
4. Request a tenant access token using `app_id` and `app_secret`.
5. Expand `titleTemplate` using the configured timezone.
6. List files in the target folder.
7. Find documents whose title exactly matches today's generated title.
8. If no matching document exists, create one in the target folder.
9. If one matching document exists, update it.
10. If multiple matching documents exist, update the most recently modified or created document and return a warning.
11. Convert digest Markdown into Feishu document blocks.
12. Replace the document body with the converted blocks.
13. Return a JSON result with status, action, title, URL, and warnings if any.

Example success output:

```json
{
  "status": "ok",
  "method": "feishu_doc",
  "action": "updated",
  "title": "AI Builders Digest - 2026-05-28",
  "url": "https://..."
}
```

## Idempotency

The idempotency key is the generated daily title within the configured folder. The same day and same folder should map to one Feishu document.

Rules:

- The date is calculated from `delivery.feishu.timezone`, global `timezone`, then the local system timezone.
- `{{date}}` expands to `YYYY-MM-DD`.
- Search only within the configured folder.
- Match documents by exact title.
- Re-running on the same day replaces the document body.
- Do not append duplicate content.
- Multiple matching documents should not fail delivery; update the newest match and report a warning.

## Markdown Block Mapping

Implement a stable subset of Markdown suitable for the digest format:

- `#`, `##`, and `###` become heading blocks.
- Normal paragraphs become text blocks.
- `- ` and `* ` become unordered list blocks.
- `1. ` becomes ordered list blocks.
- A standalone URL line becomes a clickable link text block.
- Inline Markdown links, such as `[text](url)`, become linked text where Feishu rich text supports it.
- `---` becomes a divider block if supported, otherwise an empty paragraph.
- Empty lines separate blocks and should not create excessive blank blocks.
- Tables, images, code blocks, and footnotes are treated as plain text in the first version.

When `includeMetadata` is true, prepend metadata similar to:

```text
Generated at: 2026-05-28 08:00 Asia/Shanghai
Source: follow-builders
```

Fallback behavior:

- If rich-text link conversion fails, keep the original text and URL.
- If a single structured block cannot be represented, write that content as plain text.
- If structured batch insertion fails, replace the body with a plain-text version of the full digest and mark the result with `fallback: "plain_text"`.

## Error Handling

Configuration errors should fail fast with clear JSON:

- Missing `delivery.feishu.appId`.
- Missing app secret environment variable.
- Missing `delivery.feishu.folderToken`.
- Unsupported `onExisting` value.

Feishu API errors should preserve useful diagnostic data:

- Authentication failure.
- Missing app permission.
- No access to target folder.
- Document creation failure.
- Document body read, delete, or insert failure.

Content conversion errors should prefer preserving the digest over failing the run. Use warnings and fallback text where possible.

## Tests

Add focused automated coverage:

- Markdown conversion tests using `examples/sample-digest.md`.
- Heading, paragraph, unordered list, ordered list, URL line, and Markdown link conversion cases.
- Title template tests for `{{date}}` under `Asia/Shanghai`.
- Config validation tests for missing app ID, secret, and folder token.
- Fetch-mocked Feishu client tests for token acquisition, document create, existing document update, multiple duplicate title warning, and API failures.

Manual verification:

1. Configure a test Feishu folder token and app credentials.
2. Write a digest file to `/tmp/fb-digest.txt`.
3. Run `node deliver.js --file /tmp/fb-digest.txt`.
4. Confirm a document is created in the folder.
5. Run the command again on the same day.
6. Confirm the same document is updated, not duplicated.

## Documentation Updates

Update:

- `config/config-schema.json` with `feishu_doc` and `delivery.feishu`.
- `SKILL.md` with setup and delivery workflow instructions.
- `README.md` and `README.zh-CN.md` with Feishu document delivery as an available method.

Do not change:

- Feed fetching.
- LLM remix prompts.
- Source list management.
- Scheduling semantics beyond allowing scheduled runs to use `feishu_doc`.
- OAuth support.
- Database or remote state storage.

## Implementation Scope

First implementation should deliver:

- Manual and scheduled runs can both call `deliver.js`.
- `delivery.method = "feishu_doc"` writes one document per day to the configured folder.
- Same-day reruns update the existing document.
- Digest Markdown is converted into readable Feishu blocks.
- Plain text fallback is available.
- Errors are actionable enough to diagnose credentials and permissions.

Future work can add:

- Personal OAuth.
- More complete Markdown support.
- A general publisher abstraction.
- Rich onboarding for non-technical users.
- Feishu-specific scheduling examples beyond the generic delivery path.
