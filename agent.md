# Agent Safety Notes

## PowerShell Command Safety

- Never include bare `>` or `<` in search/read commands.
- When searching text containing `">"` or `"<"`, wrap the whole pattern in single quotes and prefer `--fixed-strings`.
- Example safe form:
  - `rg -n --fixed-strings 'section-label">' src/App.tsx`
- After any command with special characters, run `git status --short` immediately to confirm no file was unintentionally truncated.

