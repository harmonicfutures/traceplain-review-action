# Traceplain Agent Review Action

Create a conservative Markdown handback from a Codex `exec --json` record or an OpenTelemetry OTLP/JSON trace. The action runs inside your GitHub-hosted or self-hosted runner and makes no network request to Traceplain. It does not upload the input record, create an approval, or claim that the record is complete.

## Use it

```yaml
- name: Create agent handback
  id: traceplain
  uses: harmonicfutures/traceplain-review-action@v1
  with:
    path: artifacts/codex-run.jsonl

- name: Upload handback
  uses: actions/upload-artifact@v4
  with:
    name: traceplain-handback
    path: ${{ steps.traceplain.outputs.handback-path }}
```

OTLP/JSON works with the same action:

```yaml
- uses: harmonicfutures/traceplain-review-action@v1
  with:
    path: artifacts/otel-export.json
    detail: safe
```

The default `safe` detail mode suppresses imported command text, paths, messages, model names, service names, and tool names. Set `detail: names` only when those bounded identifiers are appropriate for the resulting artifact.

## What the handback says

The Markdown output separates:

- **Observed** terminal events or spans present in the supplied record.
- **Agent-reported** completion messages, which are not treated as proof.
- **Attention** signals such as failure, denial, file change, OTLP `ERROR`, or OTLP `UNSET` status.
- **Unknowns** that cannot be inferred from an incomplete or externally produced record.
- The **human decision** that remains after the projection.

`no_explicit_failure` never means approved. It means only that this limited projection found no explicit failure signal in the supplied record.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `path` | required | Codex JSONL/NDJSON or OTLP JSON file inside the runner. |
| `output` | `traceplain-handback.md` | Markdown output path. |
| `detail` | `safe` | `safe` or `names`. |
| `max-bytes` | `10485760` | Maximum accepted input size. |
| `fail-on-review` | `false` | Fail the step when the verdict is `review_needed`. |

The action exposes `handback-path`, `verdict`, `format`, and `event-count` outputs.

## Security and evidence boundary

- No dependency installation and no outbound request are performed by the action.
- The input is read only from the runner filesystem.
- The generated Markdown remains on the runner unless your workflow explicitly uploads, commits, or publishes it.
- Raw imported values are not printed to workflow commands or logs.
- Input size and projected event count are bounded.
- Unsupported formats stop with an error instead of being guessed.

Review logs before using `detail: names` or uploading the output as an artifact. Repository maintainers still control workflow permissions, artifact retention, and acceptance of any agent-produced change.

## Free browser reviewer

For interactive local review, safe examples, and printable handbacks, use [Traceplain](https://traceplain.zakgov.com/?utm_source=github&utm_medium=action-readme&utm_campaign=traceplain-review-action). The optional A$29 Review Kit is separate from this free action.

## License

MIT
