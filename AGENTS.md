# Repository Agent Instructions

## Feature delivery

When implementing a new feature:

1. Run the relevant tests and checks. Do not commit or push if they fail; report the failure.
2. Stage only the files changed for that feature. Preserve unrelated user changes and never stage secrets.
3. Create a descriptive commit for the feature, then push the current branch to `https://github.com/EricMamai/AI_Agents`.
4. Before pushing, verify the configured remote points to that repository and the current branch is the intended feature branch. If either check fails, or GitHub access is unavailable, do not push elsewhere or force-push; report the blocker.

Do not create a feature commit or push for tasks that do not implement a feature.
