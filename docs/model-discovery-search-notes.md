# Model discovery search decisions

- Library, Create and command search now share ordered-independent token matching and the same catalog vocabulary: friendly category/provider labels, port types and labels, model enum choices and existing capability notes. Create retains its required-input exclusions.
- Common task words translate to declared media types: “animate a logo” requires video output vocabulary and image metadata. Animation words are indexed only for nodes declaring a Video output, so extracting images from a video does not satisfy an animation request. Plain “logo” searches image metadata; no bespoke model descriptions were invented.
- Source definitions currently have no description field. Displayed input summaries come from actual ports and mark optional inputs; long rows show the first three plus a count.
- The Library keeps search/provider controls fixed above its scrolling catalog. Provider filtering expands matching groups; clearing filters and suggested searches only change discovery state.
- Provider filters include every declared credential route as well as the catalog provider. A FAL filter can find Veo, and Meshy can find its direct-capable nodes. Filtering does not select a billing route; the readiness badge describes the connection that new defaults or the actual saved recipe will use.
- Each add button retains its exact accessible name and click/drag behavior. Its input summary is an accessible description. A surrounding row allows separate readiness/setup controls without nested buttons.
- Catalog browsing and adding remain available with no configured credentials. Opening, filtering and recovering discovery never generate or alter existing graph nodes, edges or history.
