---
type: Feature
title: Images
description: "Embed images from the Bundle inline."
tags: [editor]
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-28T18:00:00+01:00 }
sources:
  - id: changelog
    resource: https://github.com/pothos-dev/sunstone/blob/main/CHANGELOG.md
    title: Sunstone CHANGELOG
---

# Images

Images stored in the Bundle render inline, in the editor and on the web. Both syntaxes work:

```markdown
![[diagram.png]]
![Architecture](assets/diagram.png)
```

The wikilink form is resolved by name, like [wikilinks](/editing/links.md), so you don't have to spell out the folder. An image that can't be found shows a placeholder naming the missing file. Images dropped into the folder are picked up without a restart.
