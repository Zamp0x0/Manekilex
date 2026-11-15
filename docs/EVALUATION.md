# Evaluation: does context pick the right sense?

> Every number below comes from the final evaluation report in the author's private development repository. The benchmark data, evaluation harness and run records are kept there and are not part of this repository.

## Question

When an English word has several meanings, does Manekilex's in-context lookup explain the sense that the sentence actually uses? And how does that compare with the context-free dictionary answer?

## Benchmark

| | |
| --- | --- |
| Words | 60 polysemous words in three equal groups: everyday, academic and computing vocabulary |
| Sentences | 120: each word appears in two sentences that use **different** senses |
| Senses | 2–5 coarse senses per word, defined for the project |
| Split | By word, with a fixed seed: Dev 36 sentences, Held-out 84; both sentences of a word stay in the same split |
| Freeze | Every data file and the scoring guide were pinned by SHA-256 before the first model run, and checked before each run |
| Drafting | Sentences, senses and gold labels were drafted with AI assistance and signed off by the author in one written batch review. There was no independent blind annotation. |

The two-sentence design matters. An answer that ignores the sentence gives the same sense both times, so it can be right **at most half the time**.

## Methods compared

| Method | What it is |
| --- | --- |
| Dictionary first sense | The first sense in the bundled offline dictionary, mapped to the sense inventory by rule |
| Context-free AI lookup | The word alone sent to the model (Dev only) |
| Context-aware lookup | The extension's real lookup paths, running the production prompts and request code in a test sandbox: the full AI lookup (Dev only) and the dictionary-plus-context enhancement that most word lookups use |

Model under test: DeepSeek `deepseek-flash` (temperature 0.1, JSON output, reasoning disabled). There were 174 real requests in total: 90 on Dev and 84 on Held-out.

## Scoring

- **Context-aware answers.** Each answer was judged against the gold sense, using a written scoring guide.
- **Blind judging.** The judges saw the word, the sentence, the explanation and the candidate senses in shuffled order. They did not see the gold label, the method, the model or the item id.
- **Dictionary answers.** These were scored by rule.
- **Who labelled each split.**
  - Dev labels were drafted with AI assistance and batch-verified by the author.
  - Held-out labels were **AI-adjudicated**. Two LLM judges, from a different model family than the one under test, worked separately and agreed on all 84 items. Three answers that mentioned more than one sense were re-checked by a third separate judge.
  - The judges were kept apart by protocol, and their tool use was audited; they did not run in a technical sandbox.
  - No human verified the Held-out labels.
- **Freezing.** Judgements were frozen by hash before scoring.

## Results

### Held-out (84 sentences)

| Method | Correct | 95% Wilson interval |
| --- | --- | --- |
| Context-aware lookup | **84 / 84** | 95.6–100% |
| Dictionary first sense | 38 / 84 (45.2%) | 35.0–55.9% |

- **By word group.** The context-aware lookup scored 28 / 28 in each of the three groups. The dictionary scored 13, 13 and 12 out of 28.
- **Strong-cue sentences.** In the pre-registered subgroup of sentences with a strong context cue, the context-aware lookup scored 11 / 11 and the dictionary 0 / 11.
- **Agreement between methods.** The dictionary was wrong and the context-aware lookup right on 46 sentences. The reverse happened on none.
- **Word-level bootstrap.** Resampling words rather than sentences (10,000 resamples) gives 100–100% for the context-aware lookup and 40.5–48.8% for the dictionary.
- **What was not run.** The context-free AI lookup and the full AI lookup were not run on Held-out.

### Dev (36 sentences)

| Method | Correct |
| --- | --- |
| Context-aware lookup (both paths) | **36 / 36** (95% CI 90.4–100%) |
| Dictionary first sense | 17 / 36 (47.2%) |
| Context-free AI lookup, first sense listed | 17 / 36 (47.2%) |
| Context-free AI lookup, required to commit to one sense | 1 / 36 (2.8%) |

### Latency of the context-aware request

| | Median | p95 |
| --- | --- | --- |
| Held-out | 2,034 ms | 2,994 ms |
| Dev | 2,491 ms | 2,745 ms |

The figures are the duration of each real request as recorded by the evaluation runner.

## Product-strategy comparison, not a sole causal factor

The context-aware product strategy outperformed the dictionary first-sense baseline on this benchmark.

The methods also differ in prompts and output formats (and in answer fields and token limits), so the experiment does not isolate context as the sole causal factor. Isolating it would need an ablation in which only the sentence is added or removed.

## What this does and does not show

- **What it shows.** On this benchmark, the context-aware product strategy picked the intended sense far more often than the context-free answers. A context-free answer stays near its 50% ceiling, while the context-aware lookup reached the top of the scale on both splits.
- **The ceiling.** A perfect score means the benchmark can no longer tell finer differences apart. It is **not** a claim of 100% accuracy in everyday reading.
- **The scope of the result:**
  - one model and one provider;
  - 60 words;
  - sentences written for the test;
  - AI-adjudicated Held-out labels. The judges belong to the same model family that helped draft the gold labels, which may make agreement easier.
- **What would strengthen it:**
  - human verification of the Held-out labels;
  - a second human annotator;
  - other models;
  - harder, naturally occurring sentences.
