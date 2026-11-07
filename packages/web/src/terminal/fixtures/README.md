Real Claude Code 2.1.319 screens (`hc read` of throwaway `claude --model haiku` terminals, 2026-11-07), for prompt.test.ts and ApproveBar.test.tsx.

- ask-multi-*: 200 columns, one AskUserQuestion with 3 questions (single long / multi-select / single), at each step: cursor moves, a chosen answer seen again (✔), ticks, "Type something" typed, Next row, review.
- ask-narrow-*: 72 columns (`stty cols 72`): a multi-select question alone, a single question alone, Enter unticking a typed answer, review.
- ask-review-unanswered: review step with the "not answered all questions" warning.
- perm-narrow-bash: a Bash permission prompt at 72 columns (wrapped options).
