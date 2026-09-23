# Signal Playbooks

Nineteen playbooks. Each one answers a single question:

> A campaign needs signal X on every row. What is the cheapest reliable way to get X, and what exact prompt turns X into copy-ready text?

One playbook produces one field. `new_in_role_line`. `funding_line`. `pricing_page_line`. That field
slots into one sentence of email 1. That is the whole product.

**Start with [`clay-playbooks/`](clay-playbooks/)** — the index, the shared conventions, and the two
build harnesses.

## Three ways to run every playbook

| File | What it is | Use it when |
|---|---|---|
| `SKILL.md` | the playbook: source chain, output contract, locked prompt, edge cases | running the signal from Claude on a list |
| `clay-table.md` | the Clay **table** build: columns, formulas, credit gates | the signal runs continuously on a client table |
| `clay-workflow.md` | a pointer to the **tested Clay CLI skill** in [`../clay-cli-playbooks/`](../clay-cli-playbooks/) | you want it to run on Clay alone, from a terminal |

**Why tables are browser-driven and workflows are CLI-driven.** This is a real constraint, not a
style choice. The `clay` CLI's `tables` command group is read-only — it cannot create a table or add
a column, so tables are built in the UI. Workflows are the opposite: `clay workflows create` /
`nodes create` / `publish` / `runs` all exist, so a workflow can be built end to end from a terminal.

## Status: recipes, not verified builds

Each `SKILL.md` carries a verification line saying what was actually run and on how many rows. Where
it says PASS, real rows were graded.

⚠️ **The `clay-table.md` files have not been built in a live Clay workspace.** They are written
against the real Clay action catalog, so the shapes are right, but treat them as specifications.
Build one, run it on 5 rows, read the output, and fix the file.

✅ **The Clay CLI versions were run live.** Every `clay-workflow.md` now points to a skill in
[`../clay-cli-playbooks/`](../clay-cli-playbooks/) that was built and run in a real Clay workspace on
2026-09-23 and passes Clay's marketplace validator. Its README has the status of each one.

## The 19

### Person signals — the person did something
| Playbook | Output | What it says |
|---|---|---|
| [`playbook-new-in-role`](playbook-new-in-role/) | `new_in_role_line` | they just took this seat |
| [`playbook-linkedin-engagement`](playbook-linkedin-engagement/) | engager rows | they engage with a competitor's or customer's posts |
| [`playbook-social-posts`](playbook-social-posts/) | `social_post_text` | they posted something you can speak to |
| [`playbook-warm-intros`](playbook-warm-intros/) | `warm_intro_line` | they are already one hop from you |

### Company signals — the company did something
| Playbook | Output | What it says |
|---|---|---|
| [`playbook-fundraising`](playbook-fundraising/) | `funding_line` | they raised, so they are buying |
| [`playbook-hiring-surge`](playbook-hiring-surge/) | `hiring_surge_line` | they are growing the team you sell to |
| [`playbook-job-posting-language`](playbook-job-posting-language/) | `job_posting_line_safe` | their own job post names your problem |
| [`playbook-ad-library`](playbook-ad-library/) | `ad_library_line` | they are spending on paid social right now |

### Website signals — their site says something
| Playbook | Output | What it says |
|---|---|---|
| [`playbook-pricing-page`](playbook-pricing-page/) | pricing record | how they price, read off their own page |
| [`playbook-case-study-page`](playbook-case-study-page/) | `case_study_line` | who they brag about serving |
| [`playbook-tech-on-website`](playbook-tech-on-website/) | `tech_confirmed` | what they run, verified against the live site |
| [`playbook-google-site-search`](playbook-google-site-search/) | `site_keyword_line` | does their site mention X |

### List shaping — these make the others work
| Playbook | Output | What it says |
|---|---|---|
| [`playbook-company-name-cleaning`](playbook-company-name-cleaning/) | `company_clean` | "Irby Utilities, LLC" becomes "Irby" |
| [`playbook-first-name-cleaning`](playbook-first-name-cleaning/) | `first_name_clean` | "Dr Ruba" becomes "Ruba" |
| [`playbook-social-link-finding`](playbook-social-link-finding/) | profile URLs | domain to verified social profiles |
| [`playbook-lookalikes`](playbook-lookalikes/) | company list | more companies like your best customer |
| [`playbook-name-to-other-prospects`](playbook-name-to-other-prospects/) | `other_prospects` | "is this you or Jeff?" |

### Copy generation — these turn signals into words
| Playbook | Output | What it says |
|---|---|---|
| [`playbook-ai-specificity`](playbook-ai-specificity/) | `specificity_line` | make a generic offer feel written for them |
| [`playbook-creative-ideas`](playbook-creative-ideas/) | 3 bullets | the "I had a few ideas" email |

## Rules that apply to all 19

1. **One playbook, one field.** Need two signals? Run two playbooks and let the copy pick.
2. **Abstain is an empty string.** Never "N/A", never a guess. A blank is cheap; a confident wrong
   sentence about someone's own job costs you the account.
3. **The model never establishes a fact.** Every fact goes into the prompt already proven by a
   structured source. The model turns a fact list into one sentence, nothing more.
4. **Deterministic fields are computed in code.** Dates, counts, enums, anything that branches the
   copy. Models are for prose.
5. **Gate the paid column.** No paid enrichment on a row that failed a free upstream check or has no
   valid email. This is the single biggest cost lever.
6. **Run 5 rows and read them before you run 5,000.** The failure modes are silent: empty columns,
   unbound variables, and gates that drop every row all look identical to "still processing".
7. **Spintax cannot gate an empty variable.** It picks at random and cannot see emptiness. Use a
   pre-rendered whole sentence, or split the list at upload.

## Using these as Claude Code skills

Each playbook directory is a standard skill (`SKILL.md` with frontmatter). Because they live one
level deeper than the rest of the repo, point Claude at this directory — or symlink the ones you use
up into your skills root:

```bash
ln -s "$PWD/skills/playbooks/playbook-new-in-role" ~/.claude/skills/playbook-new-in-role
```
