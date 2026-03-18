---
name: fact-check
description: Verify factual claims through deep research. Use when you need to fact-check a statement, verify information from a source, or investigate whether something is true. Spawns a background job that notifies you when complete.
---

# Fact Checker

Spawns a remote Claude session to investigate and verify factual claims. The session runs in the background - the user will be notified via Discord/Slack/email when it completes, with a link to the full report.

## Gather the Request

Ask the user what they want fact-checked. Get:

1. **The claim or question** - What needs to be verified?
2. **Source context** (optional) - Where did they encounter this? (URL, document, conversation)

Keep it simple - just get enough to start the investigation.

## Spawn the Fact-Checker

### Step 1: Get a one-time token

```python
user_info = mcp__memory-system__meta_get_user(generate_one_time_key=True)
token = user_info["one_time_key"]
```

### Step 2: Spawn the session

```bash
~/.claude/hooks/spawn-claude.sh "<token>" "Fact-check this claim: {claim}\n\nSource: {source context or 'Not provided'}"
```

The remote environment has a CLAUDE.md with full instructions on methodology, report format, and how to create notes and notify the user.

### Step 3: Confirm to user

Tell them the session has been spawned and they'll be notified when complete. Include the session_id from the response so they can check on it if needed.

## Example

**User**: "Can you fact-check this? I read that honey never spoils."

**You**:
1. Get one-time token
2. Spawn session with: `"Fact-check this claim: Honey never spoils\n\nSource: Not provided"`
3. Respond: "I've started a fact-check on whether honey never spoils. Session ID: u1-e8-abc123. You'll get a notification when the investigation is complete, with a link to the full report."
