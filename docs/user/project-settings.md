# Project settings

Open **Settings → Projects** and select a project to change its preferences.

## Project icons

Choose an icon, emoji, or image from the project to make it easier to recognize. The choice applies
to every checkout in the project group and appears on connected clients. Choose **Automatic** to
let T3 Code detect an icon again.

## Keep the default branch current

Enable **Automatically pull** to keep the default-branch checkout up to date with its configured
upstream.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.

Pull failures do not prevent the server from starting.

## Thread machines

When an environment supports isolated thread machines, projects added to that environment start
with **Thread machines** enabled. New threads then run inside their own machine instead of falling
back to the environment host.

To change this for a project, open **Settings**, select **Projects**, choose the project, and change
**Thread machines**. The setting applies to threads created after the change.
