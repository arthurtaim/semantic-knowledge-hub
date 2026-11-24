"""Isolated worker that runs the Claude Code CLI for the EXPERIMENTAL `claude_cli` AI provider.

It only turns (system prompt, prompt) into model text: no tools, no MCP servers, no settings files,
no session persistence, an empty working directory per request and a minimal environment. It has no
access to the knowledge base, GitLab, Confluence or the application's data (docs/CLAUDE_CODE_CLI_INTEGRATION.md).
"""
