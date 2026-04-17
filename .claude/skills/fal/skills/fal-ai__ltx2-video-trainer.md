---
name: fal-ai/ltx2-video-trainer
display_name: LTX-2 Video Trainer
category: training
creator: Lightricks
fal_docs: https://fal.ai/models/fal-ai/ltx2-video-trainer
original_source: https://ltx.io/model/ltx-2
summary: High-performance LoRA trainer for the LTX-2 DiT video foundation model, supporting synchronized audio-video training.
---

# LTX-2 Video Trainer

## Overview
- **Slug:** fal-ai/ltx2-video-trainer
- **Category:** Video Training
- **Creator:** [Lightricks](https://ltx.io/)
- **Best for:** Fine-tuning the LTX-2 video model on custom styles, characters, or specific visual effects with synchronized audio support.
- **FAL docs:** [fal.ai/models/fal-ai/ltx2-video-trainer](https://fal.ai/models/fal-ai/ltx2-video-trainer)
- **Original source:** [Lightricks LTX-2 Official Page](https://ltx.io/model/ltx-2), [Hugging Face](https://huggingface.co/Lightricks/LTX-2), [GitHub](https://github.com/Lightricks/LTX-2)

## What it does
The **LTX-2 Video Trainer** is a specialized LoRA (Low-Rank Adaptation) training endpoint for the LTX-2 video foundation model. LTX-2 is a 19-billion parameter Diffusion Transformer (DiT) architecture designed by [Lightricks](https://ltx.io/) that generates synchronized 4K video and audio in a single process. This trainer allows users to provide a dataset of images or videos to "teach" the model new styles, concepts, or characters, producing a `.safetensors` file that can be used for inference. It is particularly powerful because it supports joint audio-video training, ensuring that the generated sounds match the custom visuals.

## When to use this model
- **Use when:** You need a consistent visual style across multiple generated videos, or you want to train the model on a specific character or object that doesn't exist in the base model's training data.
- **Don't use when:** You need generic video generation (use the base [LTX-2](https://fal.ai/models/fal-ai/ltx-2/image-to-video) instead); or when you have fewer than 10 high-quality training samples.
- **Alternatives:** 
  - **Flux LoRA Fast Training:** For high-quality image-to-image style training.
  - **Kling Video:** A strong alternative for general high-fidelity video generation, though it lacks a public LoRA trainer on FAL as of now.
  - **LTX Video 2.0 Pro:** Use this for high-fidelity inference once your LoRA is trained.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/ltx2-video-trainer` (sync) / `https://queue.fal.run/fal-ai/ltx2-video-trainer` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `training_data_url` | string | (Required) | URL | A zip archive containing ONLY videos (.mp4, .mov, .avi, .mkv) or ONLY images (.png, .jpg, .jpeg). Mixed datasets are not supported. |
| `rank` | enum | `32` | 8, 16, 32, 64, 128 | The rank of the LoRA adaptation. Higher values increase capacity but use more memory and can lead to slower training. |
| `number_of_steps` | integer | `2000` | 1 - 10000+ | Total training steps. More steps usually mean better concept adherence but increase cost and risk of overfitting. |
| `learning_rate` | float | `0.0002` | 1e-6 - 1e-3 | Optimization speed. Higher values can cause instability; lower values require more steps. |
| `number_of_frames` | integer | `89` | N % 8 == 1 | Frames per training sample. Common values: 9, 17, 25, 33, 41, 49, 57, 65, 73, 81, 89, 97, 121, 161. |
| `frame_rate` | integer | `25` | 1 - 60 | Target FPS for the video dataset. |
| `resolution` | enum | `medium` | low, medium, high | Training resolution. Higher resolutions require significantly more memory. |
| `aspect_ratio` | enum | `16:9` | 16:9, 1:1, 9:16 | Aspect ratio for training samples. |
| `trigger_phrase` | string | `""` | Any string | A phrase (e.g., "in the style of [name]") prepended to captions to trigger the LoRA. |
| `auto_scale_input` | boolean | `false` | true, false | Automatically scales videos to the target frame count and FPS. |
| `split_input_into_scenes` | boolean | `true` | true, false | Splits long videos into scenes based on a duration threshold. |
| `split_input_duration_threshold` | float | `30` | 1.0 - 60.0 | Threshold in seconds for scene splitting. |
| `debug_dataset` | boolean | `false` | true, false | If true, returns a zip of preprocessed data for manual inspection. |
| `with_audio` | boolean | `null` | true, false, null | Enables joint audio-video training. If null, it auto-detects based on input. |
| `audio_normalize` | boolean | `true` | true, false | Normalizes audio peak amplitude to a consistent level. |
| `first_frame_conditioning_p` | float | `0.5` | 0.0 - 1.0 | Probability of conditioning on the first frame, improving image-to-video performance. |
| `validation` | list | `[]` | Object List | A list of prompts and optional images to generate during training to monitor progress. |
| `stg_scale` | float | `1.0` | 0.0 - 2.0 | Spatio-Temporal Guidance scale. 0.0 disables it. |

### Output
The output is a JSON object containing URLs to the resulting model files:
- `lora_file`: A URL to the trained LoRA weights in `.safetensors` format.
- `config_file`: A URL to the configuration file required to load the LoRA for inference.
- `video`: (Optional) URLs to validation videos generated during the training process.
- `debug_dataset`: (Optional) URL to the preprocessed training data archive.

### Example request
```json
{
  "training_data_url": "https://example.com/my_dataset.zip",
  "trigger_phrase": "in the style of TOK",
  "number_of_steps": 2000,
  "rank": 32,
  "validation": [
    {
      "prompt": "A man walking through a forest in the style of TOK"
    }
  ]
}
```

### Pricing
FAL.ai charges **$0.0048 per step** for the LTX-2 Video Trainer. 
- A standard **2000-step** training run costs **$9.60**.
- Pricing is independent of the number of images or videos provided, but longer/higher resolution training will take more time.

## API — via Original Source (BYO-key direct)
Lightricks provides a native API for LTX-2 inference at `https://api.ltx.video/v1/`, but they do not currently document a public "Training-as-a-Service" endpoint similar to FAL.ai's trainer. Instead, they provide **Open Weights** and training scripts on [GitHub](https://github.com/Lightricks/LTX-2) and [Hugging Face](https://huggingface.co/Lightricks/LTX-2.3) for local or private cloud training.
- **Native Inference Endpoint:** `https://api.ltx.video/v1/text-to-video`
- **Auth:** Bearer Token (API Key from [LTX Console](https://console.ltx.video/))
- **BYO-Key Note:** Users can run the [LTX-2 weights](https://huggingface.co/Lightricks/LTX-2) on their own hardware or via ComfyUI. FAL.ai is the primary managed API surface for the LoRA training process itself.

## Prompting best practices
1. **Be Descriptive:** LTX-2 thrives on detailed prompts. Describe the scene, camera movement, and mood explicitly (e.g., "A cinematic wide aerial shot...").
2. **Use Camera Keywords:** The model understands camera terminology like "Dolly in", "Dolly out", "Close-up", and "Pan".
3. **Trigger Phrases:** Always include your `trigger_phrase` at the beginning of your prompt during inference to activate the LoRA.
4. **Negative Prompts:** Use a standard negative prompt like "worst quality, inconsistent motion, blurry, jittery, distorted" to maintain fidelity.
5. **Realism vs. Animation:** Specify the medium (e.g., "live-action cinematic", "3D animated", "stop-motion") to guide the model's output structure.

## Parameter tuning guide
- **Rank:** Start with `32`. If the style is very complex or subtle, try `64` or `128`, but be aware this increases the risk of overfitting and memory usage.
- **Steps:** `2000` is the sweet spot for most datasets. If the model hasn't "captured" the concept in validation, increase to `4000`. If it's distorting the base model's capabilities, decrease to `1000`.
- **Learning Rate:** The default `0.0002` is highly stable. Only decrease it (e.g., `1e-5`) if you are using a very high step count and notice the model is "exploding" or producing artifacts.
- **Number of Frames:** Match this to your dataset's average video length. Remember to follow the `N % 8 == 1` rule.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `Dataset ZIP URL`: Port for the training data archive.
  - `Training Parameters`: Ports for steps, rank, and learning rate.
  - `Validation Prompts`: Port for a list of test scenarios.
  - `Trigger Word`: Port for the phrase to associate with the style.
- **Outputs:**
  - `LoRA Weights`: Output port for the `.safetensors` file.
  - `Config File`: Output port for the inference configuration.
  - `Preview Videos`: Port for validation video outputs.
- **Chain-friendly with:**
  - **LTX-2 Image-to-Video:** To use the trained LoRA for final video generation.
  - **Flux 2 Flex:** To generate high-quality starting images for the LTX-2 I2V pipeline.

## Notes & gotchas
- **Dataset Consistency:** Do not mix images and videos in the same zip file; the trainer will fail.
- **Resolution Math:** LTX-2 requires resolutions to be divisible by 32. If you provide odd resolutions, they will be padded and cropped.
- **Audio Support:** If training with audio, ensure your input videos have high-quality, clear sound as the model learns to synchronize the two.
- **Rate Limits:** FAL training jobs can take significant time; always use the `queue` mode for stable production workflows.

## Sources
- [FAL.ai LTX-2 Trainer API Documentation](https://fal.ai/models/fal-ai/ltx2-video-trainer/api)
- [Lightricks LTX-2 Research Paper](https://cdn.prod.website-files.com/68872d15af29880764eac4aa/695c06aa63b560e217a68363_LTX_2_Technical_Report_compressed.pdf)
- [Official LTX-2 Documentation](https://docs.ltx.video/)
- [Lightricks Hugging Face Model Card](https://huggingface.co/Lightricks/LTX-Video)