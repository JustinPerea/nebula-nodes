---
name: fal-ai/got-ocr/v2
display_name: GOT-OCR2 (General OCR Theory)
category: vision
creator: Stepfun-ai (Haoran Wei, Chenglong Liu, et al.)
fal_docs: [FAL.ai Model Page](https://fal.ai/models/fal-ai/got-ocr/v2), [FAL.ai API Docs](https://fal.ai/models/fal-ai/got-ocr/v2/api)
original_source: [GitHub Repository](https://github.com/Ucas-HaoranWei/GOT), [HuggingFace Model Card](https://huggingface.co/stepfun-ai/GOT-OCR2_0)
summary: An advanced 580M parameter OCR model that handles everything from plain text and scene text to complex charts, formulas, and sheet music.
---

# GOT-OCR2 (General OCR Theory)

## Overview
- **Slug:** `fal-ai/got-ocr/v2`
- **Category:** Vision / OCR
- **Creator:** [Stepfun-ai](https://huggingface.co/stepfun-ai)
- **Best for:** Extracting structured data (Markdown, LaTeX) from complex documents, charts, and formulas.
- **FAL docs:** [https://fal.ai/models/fal-ai/got-ocr/v2](https://fal.ai/models/fal-ai/got-ocr/v2)
- **Original source:** [GitHub (Ucas-HaoranWei/GOT)](https://github.com/Ucas-HaoranWei/GOT) / [HuggingFace](https://huggingface.co/stepfun-ai/GOT-OCR2_0)

## What it does
GOT-OCR2 is a "Next Generation" OCR-2.0 model designed to unify diverse optical character recognition tasks into a single, efficient end-to-end architecture. With only 580 million parameters, it achieves state-of-the-art performance by using a high-compression vision encoder and a long-context decoder. Beyond standard text, it can recognize mathematical formulas, tables, charts, geometric shapes, molecular formulas (SMILES), and even sheet music.

## When to use this model
- **Use when:** 
    - You need to convert printed or handwritten math formulas into LaTeX.
    - You are extracting data from complex tables or charts that traditional OCR fails to structure.
    - You have documents with mixed content (text, diagrams, and formulas).
    - You need Markdown-formatted output for document digitization.
- **Don't use when:** 
    - You need extremely high-resolution processing for tiny text on massive pages (native resolution is capped at 1024x1024).
    - You require real-time low-latency response for simple text snippets (standard LLMs with vision or dedicated light OCRs might be faster).
- **Alternatives:** 
    - **fal-ai/qwen-vl:** Good for general vision-language tasks but less specialized for formula/chart structure.
    - **fal-ai/florence-2:** Excellent for object detection and captioning, but GOT-OCR2 is superior for dense document OCR.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/got-ocr/v2` (sync) / `https://queue.fal.run/fal-ai/got-ocr/v2` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `input_image_urls` | `list<string>` | *Required* | Any valid image URLs | A list of URLs for the images to be processed. |
| `do_format` | `boolean` | `false` | `true`, `false` | If enabled, the model generates output in formatted mode (e.g., Markdown, LaTeX). |
| `multi_page` | `boolean` | `false` | `true`, `false` | If enabled, treats the provided images as pages of a single document to generate a continuous output. |

### Output
The output is a JSON object containing a list of strings representing the extracted text for each image (or a single string if `multi_page` is true).

```json
{
  "outputs": [
    "Extracted text content..."
  ]
}
```

### Example request
```json
{
  "input_image_urls": [
    "https://example.com/document_page_1.png"
  ],
  "do_format": true,
  "multi_page": false
}
```

### Pricing
- **Cost:** $0.05 per image.
- **Billing:** Charged per successful request based on the number of images processed.

## API — via Original Source (BYO-key direct)
Stepfun-ai provides an "Open Platform" at [platform.stepfun.ai](https://platform.stepfun.ai/), but they primarily offer their "Step" series LLMs (e.g., Step-1, Step-2) as hosted APIs. The GOT-OCR2 model is currently best accessed as an open-weights model via **HuggingFace Transformers** or through third-party providers like **FAL.ai**. 
- **Direct self-hosting:** You can run the model locally using the `transformers` library (`AutoModelForImageTextToText`).
- **Additional Native Params:** The original implementation supports `ocr_type` (plain, format, crop, find), `ocr_box` (for coordinate-based region OCR), and `ocr_color` (for color-guided interactive OCR), which are not yet fully exposed in the simplified FAL.ai schema.

## Prompting best practices
- **Enable Formatting:** Always set `do_format: true` if your image contains tables, math, or chemistry. This triggers the model's ability to output structured Markdown or LaTeX.
- **Image Quality:** Ensure the document is well-lit and flat. While the model is robust, extreme perspective distortion can affect table alignment.
- **Language Detection:** The model is optimized for English and Chinese. For other languages, results may vary in accuracy.
- **Specific Tasks:** If you want specific outputs like LaTeX, ensure the image is focused on the formula; the model naturally switches modes based on content when `do_format` is active.

## Parameter tuning guide
- **`do_format`:** This is the most impactful toggle. Turn it **OFF** for standard scene text (like a street sign) to get cleaner raw text. Turn it **ON** for anything that has a visual structure (books, papers, invoices).
- **`multi_page`:** Use this when processing a multi-image PDF export. It helps the model maintain context across page breaks, preventing fragmented sentences.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Images`: Array of Image URLs or Files.
    - `Format Mode`: Boolean toggle for structured output.
    - `Document Mode`: Boolean toggle for multi-page stitching.
- **Outputs:**
    - `Text Content`: The extracted string (Markdown/Plain).
- **Chain-friendly with:**
    - **fal-ai/flux-pro:** Use OCR to extract text from a generated image to verify text rendering accuracy.
    - **LLM Nodes (GPT-4o/Claude 3.5):** Pass the structured Markdown from GOT-OCR2 into an LLM for data extraction or summarization.

## Notes & gotchas
- **Resolution Limit:** The model internally scales images to **1024x1024**. For very long documents or tiny fine print, you may need to crop the image into patches manually before sending to the API.
- **Processing Time:** While highly efficient, `multi_page` mode with many images may increase the risk of timeout on the synchronous endpoint; use the `queue` endpoint for large documents.
- **Sheet Music:** The model outputs specialized text for sheet music which may require further processing with tools like `verovio` to render back to SVG/PDF.

## Sources
- [FAL.ai Model Documentation](https://fal.ai/models/fal-ai/got-ocr/v2/api)
- [Stepfun-ai GOT-OCR2 HuggingFace Model Card](https://huggingface.co/stepfun-ai/GOT-OCR2_0)
- [General OCR Theory Paper (arXiv:2409.01704)](https://arxiv.org/abs/2409.01704)
- [Stepfun-ai GitHub Repository](https://github.com/Ucas-HaoranWei/GOT)