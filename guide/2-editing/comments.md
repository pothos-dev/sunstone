---
type: Feature
title: Comments
description: "Margin comments stored as CriticMarkup inside the file."
tags: [editor, agents]
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-28T18:00:00+01:00 }
sources:
  - id: changelog
    resource: https://github.com/pothos-dev/sunstone/blob/main/CHANGELOG.md
    title: Sunstone CHANGELOG
---

# Comments

Select text in Live or Read mode and choose **Add comment** from the context menu. The passage is highlighted, a comment icon appears in the gutter, and hovering shows the note. Click it to edit.

On disk a comment is plain [CriticMarkup](https://fletcher.github.io/MultiMarkdown-6/syntax/critic.html):

```markdown
{==the highlighted passage==}{>>the note<<}
```

Comments live in the `.md` file and travel through git with it, and any tool can read them. This is handy for reviewing an agent's generated docs before its next pass.

CriticMarkup is also how [Review](/4-git/review-changes.md) shows word-level edits.
