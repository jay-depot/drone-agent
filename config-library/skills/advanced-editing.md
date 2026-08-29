---
name: advanced-editing
description: 'Advanced editing techniques when apply_diff is not giving the expected results'
recall:
  - diff mangled the file
  - the edit landed in the wrong place
  - complex file edits
model-invocation: true
---

# Advanced Editing Techniques

## Draft the file in notepad, then use that to help you figure out the diff

When `apply_diff` is not working as expected, because the edit you want to make is complex, write the end state of the file you want to see into your session notepad, and then compare _that_ to the actual file to figure out the diff, rather than try to determine it directly.

As a last resort, if a change is truly resistant to the diff format, you can also use your session notepad to draft your updated version of the file, and directly write that back to disk using `file__write`.

## Draft the diff in notepad, review it, then apply it

When `apply_diff` is not working as expected, you can draft the diff in your session notepad, which will let you check it for ambiguities and add additional context before submitting it. Review your draft diff against the actual file before applying it.

## On a feature branch? Make small commits and stashes!

When working on a feature branch, making small commits frequently will allow you to revert any editing mistake easily and try again. So, when a change you need to make is complex, make it in several small steps, with small commits after each, so you can undo small mistakes with maximal granularity.

## Does the project have an auto-formatter? Use it!

Are most of the changes you need to make just fixing indentation or other formatting issues? If the project has any autoformatting tools (e.g. prettier), lean heavily on them to handle that part for you. Add the additional bracketing and syntax you need as a small number of long and ugly lines, and let the auto-formatter take care of the rest.

## Indentation getting absurd? Refactor!

If you find that the indentation in your file is becoming overly complex and difficult to manage, it may be a sign that the code structure itself needs to be refactored. Simplifying nested structures and breaking down large functions or components can help keep indentation levels reasonable and make future edits easier.

## Finally: Combine Techniques

In some cases, you may need to combine the above techniques to successfully make complex edits. For example, you might draft the diff in notepad, make small commits on a feature branch, and use stashes to keep your work organized. This multi-pronged approach can help you overcome the limitations of `apply_diff` and ensure your changes are applied correctly.
