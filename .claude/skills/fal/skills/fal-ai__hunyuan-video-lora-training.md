---
name: fal-ai/hunyuan-video-lora-training
display_name: Hunyuan Video LoRA Training
category: training
creator: Tencent
fal_docs: https://fal.ai/models/fal-ai/hunyuan-video-lora-training
original_source: https://github.com/Tencent-Hunyuan/HunyuanVideo
summary: Fine-tune the state-of-the-art HunyuanVideo model on your own characters, objects, or styles using LoRA.
---

# Hunyuan Video LoRA Training

## Overview
- **Slug:** `fal-ai/hunyuan-video-lora-training`
- **Category:** Video Generation (Training)
- **Creator:** [Tencent](https://github.com/Tencent-Hunyuan/HunyuanVideo)
- **Best for:** Creating custom video generation models for specific characters, objects, or artistic styles.
- **FAL docs:** [fal.ai/models/fal-ai/hunyuan-video-lora-training](https://fal.ai/models/fal-ai/hunyuan-video-lora-training)
- **Original source:** [Tencent HunyuanVideo GitHub](https://github.com/Tencent-Hunyuan/HunyuanVideo)

## What it does
Hunyuan Video LoRA Training allows users to fine-tune the HunyuanVideo foundation model—a high-performance, open-source video generation model with up to 13 billion parameters—on a custom dataset of images. By using Low-Rank Adaptation (LoRA), the training process produces a lightweight adapter file that can be used during inference to inject specific identities (people, characters), objects, or visual styles into generated videos. The resulting LoRA adapters maintain the strong motion coherence and photorealistic quality of the base HunyuanVideo model while adhering to the fine-tuned concepts.

## When to use this model
- **Use when:** You need a video model that can consistently generate a specific person, character, or brand asset that is not present in the base model's training data.
- **Don't use when:** You need to generate generic videos (use the base [fal-ai/hunyuan-video](https://fal.ai/models/fal-ai/hunyuan-video) instead) or when you only have a single image (try Image-to-Video models like [Kling](https://fal.ai/models/fal-ai/kling-video) or [Luma](https://fal.ai/models/fal-ai/luma-dream-machine)).
- **Alternatives:** 
    - **[fal-ai/flux-lora-fast-training](https://fal.ai/models/fal-ai/flux-lora-fast-training):** Use this for high-quality *image* LoRAs (FLUX.1) instead of video.
    - **[fal-ai/hunyuan-video](https://fal.ai/models/fal-ai/hunyuan-video):** The base model for inference without custom fine-tuning.

## API — via FAL.ai
**Endpoint:** `https://queue.fal.run/fal-ai/hunyuan-video-lora-training` (Training is asynchronous and requires the queue endpoint).

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `images_data_url` | `string` | *Required* | URL | A public URL to a `.zip` archive containing the training images. Use at least 4 images; more is generally better. |
| `steps` | `integer` | `1000` | `1` - `5000` | The number of training steps. More steps can improve likeness but increase cost and risk of overfitting. |
| `trigger_word` | `string` | `""` | Any string | The unique word or phrase used in prompts to activate the LoRA (e.g., "SKS", "MY_CHARACTER"). |
| `learning_rate` | `float` | `0.0001` | `0.00001` - `0.01` | The speed at which the model learns. High values can cause training to fail; low values take longer to converge. |
| `do_caption` | `boolean` | `true` | `true`, `false` | If enabled, FAL will automatically generate captions for your training images using a VLM. |
| `data_archive_format` | `string` | `null` | `zip`, `tar`, etc. | The format of the archive. Usually inferred from the URL if not provided. |

### Output
The output is a JSON object containing references to the trained weights and configuration.
```json
{
  "diffusers_lora_file": {
    "url": "https://fal.run/.../pytorch_lora_weights.safetensors",
    "content_type": "application/octet-stream",
    "file_name": "pytorch_lora_weights.safetensors",
    "file_size": 1234567
  },
  "config_file": {
    "url": "https://fal.run/.../lora_config.json",
    "content_type": "application/json",
    "file_name": "lora_config.json",
    "file_size": 1024
  }
}
```

### Example request
```json
{
  "images_data_url": "https://example.com/my_character_images.zip",
  "steps": 1000,
  "trigger_word": "character_name",
  "learning_rate": 0.0001,
  "do_caption": true
}
```

### Pricing
- **Base Cost:** ~$5.00 per standard training run (1000 steps).
- **Scaling:** Cost scales linearly with the number of `steps`. Increasing steps to 2000 would roughly double the cost.

## API — via Original Source (BYO-key direct)
The original HunyuanVideo model is open-source. Developers can run the training code natively using the official [Tencent HunyuanVideo GitHub repository](https://github.com/Tencent-Hunyuan/HunyuanVideo). 
- **Native Training Script:** `train.py` (supports LoRA via `--use_lora` flag).
- **Advanced Parameters:** Native training allows for deeper tuning, such as changing the `lora_rank` (rank of the LoRA, default 8 or 16), using the [Muon optimizer](https://github.com/Tencent-Hunyuan/HunyuanVideo-1.5), and distributed training (FSDP).
- **Direct API:** No separate official commercial API exists outside of FAL.ai and other providers like [SiliconFlow](https://www.siliconflow.com/).

## Prompting best practices
- **Include the Trigger Word:** Always include your `trigger_word` in the prompt during inference to activate the learned concept.
- **Natural Language Captions:** HunyuanVideo is trained with long, descriptive captions. For best results, use "Master mode" style prompts that describe lighting, camera movement, and composition (e.g., "A cinematic 4k video of [trigger_word] walking in a neon-lit cyberpunk city, low angle shot").
- **Avoid Over-prompting:** The model is very sensitive to instructions. Start simple and add complexity only if needed.
- **Failure Modes:** If the character likeness is low, increase training steps or lower the learning rate. If the video quality degrades or becomes static, the model may be overfit (reduce steps or LoRA strength during inference).

## Parameter tuning guide
- **Steps:** 1000 steps is a solid baseline for 10-20 images. For complex characters, you may need 1500-2000 steps.
- **Learning Rate:** `0.0001` (1e-4) is the industry standard for LoRA. If the training loss doesn't decrease, try `0.0002`. If the model "burns" (produces noise), drop to `0.00005`.
- **Images:** Quality beats quantity. 10 high-resolution, varied images (different angles, lighting) are better than 50 blurry ones.
- **Trigger Word:** Choose a unique word that doesn't exist in the English dictionary to avoid "bleeding" from existing model concepts.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Images Zip URL` (String/URL)
    - `Steps` (Integer)
    - `Trigger Word` (String)
    - `Learning Rate` (Float)
- **Outputs:**
    - `LoRA Weights URL` (File/URL)
    - `Config URL` (File/URL)
- **Chain-friendly with:**
    - **[fal-ai/hunyuan-video](https://fal.ai/models/fal-ai/hunyuan-video):** Connect the output LoRA weights to the `loras` input port of the inference node.
    - **[fal-ai/hunyuan-video/i2v](https://fal.ai/models/fal-ai/hunyuan-video):** Use the LoRA to animate a specific character starting from an initial image.

## Notes & gotchas
- **Training Time:** LoRA training is a heavy process and can take 10-30 minutes depending on the queue and step count.
- **Aspect Ratio:** The base model supports various aspect ratios, but ensure your training images roughly match the target aspect ratio for best consistency.
- **Safety:** Training on PII or non-consensual imagery is generally prohibited by FAL's content policy.

## Sources
- [FAL.ai Training Documentation](https://fal.ai/models/fal-ai/hunyuan-video-lora-training/api)
- [Tencent HunyuanVideo GitHub Repo](https://github.com/Tencent-Hunyuan/HunyuanVideo)
- [HunyuanVideo 1.5 Technical Report](https://arxiv.org/html/2511.18870v1)
- [Hugging Face Model Card](https://huggingface.co/tencent/HunyuanVideo)