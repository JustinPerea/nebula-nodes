---
name: fal-ai/flux/dev
display_name: FLUX.1 [dev]
category: text-to-image
creator: Black Forest Labs
fal_docs: https://fal.ai/models/fal-ai/flux/dev
license: commercial
published: 2025-04-01T18:10:42.284Z
summary: FLUX.1 [dev] is a 12 billion parameter flow transformer that generates high-quality images from text. It is suitable for personal and commercial use.
last_synced: 2026-04-17T14:15:19.857049+00:00
---

# FLUX.1 [dev]

## Overview
- **Slug:** `fal-ai/flux/dev`
- **Category:** text-to-image
- **Creator:** Black Forest Labs
- **License:** commercial
- **Published:** 2025-04-01T18:10:42.284Z
- **FAL docs:** [fal-ai/flux/dev](https://fal.ai/models/fal-ai/flux/dev)

FLUX.1 [dev] is a 12 billion parameter flow transformer that generates high-quality images from text. It is suitable for personal and commercial use.

## API — via FAL.ai
- **Sync endpoint:** `https://fal.run/fal-ai/flux/dev`
- **Queue endpoint:** `https://queue.fal.run/fal-ai/flux/dev`
- **Stream endpoint:** `https://fal.run/fal-ai/flux/dev/stream`

### Input parameters
| Parameter | Type | Default | Required | Description |
|---|---|---|---|---|
| `enable_safety_checker` | boolean | True |  | If set to true, the safety checker will be enabled. |
| `acceleration` | enum(none, regular, high) | none |  | The speed of the generation. The higher the speed, the faster the generation. |
| `num_inference_steps` | integer | 28 |  | The number of inference steps to perform. |
| `sync_mode` | boolean | False |  | If `True`, the media will be returned as a data URI and the output data won't be available in the request history. |
| `output_format` | enum(jpeg, png) | jpeg |  | The format of the generated image. |
| `prompt` | string |  | ✅ | The prompt to generate an image from. |
| `num_images` | integer | 1 |  | The number of images to generate. |
| `seed` | integer |  |  | 
        The same seed and the same prompt given to the same version of the model
        will output the same image every time.
     |
| `guidance_scale` | number | 3.5 |  | 
        The CFG (Classifier Free Guidance) scale is a measure of how close you want
        the model to stick to your prompt when looking for a related image to show you.
     |
| `image_size` | ? | landscape_4_3 |  | The size of the generated image. |

### Output fields
| Field | Type | | | Description |
|---|---|---|---|---|
| `has_nsfw_concepts` | array |  | ✅ | Whether the generated images contain NSFW concepts. |
| `prompt` | string |  | ✅ | The prompt used for generating the image. |
| `timings` | object |  | ✅ |  |
| `seed` | integer |  | ✅ | 
            Seed of the generated Image. It will be the same value of the one passed in the
            input or the randomly generated that was used in case none was passed.
     |
| `images` | array |  | ✅ | The generated image files info. |

### Pricing
Images are billed by rounding up to the nearest megapixel.

## Usage examples

```python
import fal_client
result = fal_client.subscribe("fal-ai/flux/dev", arguments={...})
print(result)
```

```bash
curl -X POST "https://fal.run/fal-ai/flux/dev" \
  -H "Authorization: Key $FAL_KEY" \
  -H 'Content-Type: application/json' \
  -d '{...}'
```

## Full FAL spec (llms.txt)

<details><summary>Click to expand</summary>

```
# FLUX.1 [dev]

> FLUX.1 [dev] is a 12 billion parameter flow transformer that generates high-quality images from text. It is suitable for personal and commercial use.


## Overview

- **Endpoint**: `https://fal.run/fal-ai/flux/dev`
- **Model ID**: `fal-ai/flux/dev`
- **Category**: text-to-image
- **Kind**: inference


## Pricing

- **Price**: $0.025 per megapixels

For more details, see [fal.ai pricing](https://fal.ai/pricing).

## API Information

This model can be used via our HTTP API or more conveniently via our client libraries.
See the input and output schema below, as well as the usage examples.


### Input Schema

The API accepts the following input parameters:


- **`prompt`** (`string`, _required_):
  The prompt to generate an image from.
  - Examples: "Extreme close-up of a single tiger eye, direct frontal view. Detailed iris and pupil. Sharp focus on eye texture and color. Natural lighting to capture authentic eye shine and depth. The word \"FLUX\" is painted over it in big, white brush strokes with visible texture."

- **`image_size`** (`ImageSize | Enum`, _optional_):
  The size of the generated image. Default value: `landscape_4_3`
  - Default: `"landscape_4_3"`
  - One of: ImageSize | Enum

- **`num_inference_steps`** (`integer`, _optional_):
  The number of inference steps to perform. Default value: `28`
  - Default: `28`
  - Range: `1` to `50`

- **`seed`** (`integer`, _optional_):
  The same seed and the same prompt given to the same version of the model
  will output the same image every time.

- **`guidance_scale`** (`float`, _optional_):
  The CFG (Classifier Free Guidance) scale is a measure of how close you want
  the model to stick to your prompt when looking for a related image to show you. Default value: `3.5`
  - Default: `3.5`
  - Range: `1` to `20`

- **`sync_mode`** (`boolean`, _optional_):
  If `True`, the media will be returned as a data URI and the output data won't be available in the request history.
  - Default: `false`

- **`num_images`** (`integer`, _optional_):
  The number of images to generate. Default value: `1`
  - Default: `1`
  - Range: `1` to `4`

- **`enable_safety_checker`** (`boolean`, _optional_):
  If set to true, the safety checker will be enabled. Default value: `true`
  - Default: `true`

- **`output_format`** (`OutputFormatEnum`, _optional_):
  The format of the generated image. Default value: `"jpeg"`
  - Default: `"jpeg"`
  - Options: `"jpeg"`, `"png"`

- **`acceleration`** (`AccelerationEnum`, _optional_):
  The speed of the generation. The higher the speed, the faster the generation. Default value: `"none"`
  - Default: `"none"`
  - Options: `"none"`, `"regular"`, `"high"`



**Required Parameters Example**:

```json
{
  "prompt": "Extreme close-up of a single tiger eye, direct frontal view. Detailed iris and pupil. Sharp focus on eye texture and color. Natural lighting to capture authentic eye shine and depth. The word \"FLUX\" is painted over it in big, white brush strokes with visible texture."
}
```

**Full Example**:

```json
{
  "prompt": "Extreme close-up of a single tiger eye, direct frontal view. Detailed iris and pupil. Sharp focus on eye texture and color. Natural lighting to capture authentic eye shine and depth. The word \"FLUX\" is painted over it in big, white brush strokes with visible texture.",
  "image_size": "landscape_4_3",
  "num_inference_steps": 28,
  "guidance_scale": 3.5,
  "num_images": 1,
  "enable_safety_checker": true,
  "output_format": "jpeg",
  "acceleration": "none"
}
```


### Output Schema

The API returns the following output format:

- **`images`** (`list<Image>`, _required_):
  The generated image files info.
  - Array of Image

- **`timings`** (`Timings`, _required_)

- **`seed`** (`integer`, _required_):
  Seed of the generated Image. It will be the same value of the one passed in the
  input or the randomly generated that was used in case none was passed.

- **`has_nsfw_concepts`** (`list<boolean>`, _required_):
  Whether the generated images contain NSFW concepts.
  - Array of boolean

- **`prompt`** (`string`, _required_):
  The prompt used for generating the image.



**Example Response**:

```json
{
  "images": [
    {
      "url": "",
      "content_type": "image/jpeg"
    }
  ],
  "prompt": ""
}
```


## Usage Examples

### cURL

```bash
curl --request POST \
  --url https://fal.run/fal-ai/flux/dev \
  --header "Authorization: Key $FAL_KEY" \
  --header "Content-Type: application/json" \
  --data '{
     "prompt": "Extreme close-up of a single tiger eye, direct frontal view. Detailed iris and pupil. Sharp focus on eye texture and color. Natural lighting to capture authentic eye shine and depth. The word \"FLUX\" is painted over it in big, white brush strokes with visible texture."
   }'
```

### Python

Ensure you have the Python client installed:

```bash
pip install fal-client
```

Then use the API client to make requests:

```python
import fal_client

def on_queue_update(update):
    if isinstance(update, fal_client.InProgress):
        for log in update.logs:
           print(log["message"])

result = fal_client.subscribe(
    "fal-ai/flux/dev",
    arguments={
        "prompt": "Extreme close-up of a single tiger eye, direct frontal view. Detailed iris and pupil. Sharp focus on eye texture and color. Natural lighting to capture authentic eye shine and depth. The word \"FLUX\" is painted over it in big, white brush strokes with visible texture."
    },
    with_logs=True,
    on_queue_update=on_queue_update,
)
print(result)
```

### JavaScript

Ensure you have the JavaScript client installed:

```bash
npm install --save @fal-ai/client
```

Then use the API client to make requests:

```javascript
import { fal } from "@fal-ai/client";

const result = await fal.subscribe("fal-ai/flux/dev", {
  input: {
    prompt: "Extreme close-up of a single tiger eye, direct frontal view. Detailed iris and pupil. Sharp focus on eye texture and color. Natural lighting to capture authentic eye shine and depth. The word \"FLUX\" is painted over it in big, white brush strokes with visible texture."
  },
  logs: true,
  onQueueUpdate: (update) => {
    if (update.status === "IN_PROGRESS") {
      update.logs.map((log) => log.message).forEach(console.log);
    }
  },
});
console.log(result.data);
console.log(result.requestId);
```


## Additional Resources

### Documentation

- [Model Playground](https://fal.ai/models/fal-ai/flux/dev)
- [API Documentation](https://fal.ai/models/fal-ai/flux/dev/api)
- [OpenAPI Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/flux/dev)

### fal.ai Platform

- [Platform Documentation](https://docs.fal.ai)
- [Python Client](https://docs.fal.ai/clients/python)
- [JavaScript Client](https://docs.fal.ai/clients/javascript)
```
</details>

## Sources
- [FAL.ai docs](https://fal.ai/models/fal-ai/flux/dev)
- [FAL llms.txt](https://fal.ai/models/fal-ai/flux/dev/llms.txt)
- [OpenAPI schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/flux/dev)
