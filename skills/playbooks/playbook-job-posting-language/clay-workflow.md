# Clay CLI version: replaced by a tested skill

The untested workflow recipe that used to live here has been replaced by a skill that was built and
run live on the Clay CLI (2026-09-23, CLI 1.3.0):

**`skills/clay-cli-playbooks/job-posting-language/`**

It runs on Clay alone. Clay supplies the data through search, workflow nodes and managed functions,
and your own agent writes the copy, so you don't need a Clay AI column or an OpenAI key. It validates
clean against Clay's marketplace skill kit. What was and was not run live is listed in its
`## What this skill does not claim` section.

The Clay **table** build for this signal is still `clay-table.md` in this folder, and it is still an
untested recipe.
