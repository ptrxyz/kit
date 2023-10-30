import MagicString from 'magic-string';
import { asyncWalk } from 'estree-walker';
import { parse } from 'svelte-parse-markup';

const ASSET_PREFIX = '___ASSET___';

// TODO: expose this in vite-imagetools rather than duplicating it
const OPTIMIZABLE = /^[^?]+\.(avif|heif|gif|jpeg|jpg|png|tiff|webp)(\?.*)?$/;

/**
 * @param {{
 *   plugin_context: import('rollup').PluginContext
 *   imagetools_plugin: import('vite').Plugin
 * }} opts
 * @returns {import('svelte/types/compiler/preprocess').PreprocessorGroup}
 */
export function image(opts) {
	/**
	 * URL to image details
	 * @type {Map<string, { image: import('vite-imagetools').Picture, name: string }>}
	 */
	const images = new Map();

	return {
		async markup({ content, filename }) {
			if (!content.includes('<enhanced:img')) {
				return;
			}

			const s = new MagicString(content);
			const ast = parse(content, { filename });

			/**
			 * @param {import('svelte/types/compiler/interfaces').TemplateNode} node
			 * @param {{ type: string, start: number, end: number, raw: string }} src_attribute
			 * @returns {Promise<void>}
			 */
			async function update_element(node, src_attribute) {
				// TODO: this will become ExpressionTag in Svelte 5
				if (src_attribute.type === 'MustacheTag') {
					const src_var_name = content
						.substring(src_attribute.start + 1, src_attribute.end - 1)
						.trim();
					s.update(node.start, node.end, dynamic_img_to_picture(content, node, src_var_name));
					return;
				}

				let url = src_attribute.raw.trim();

				const sizes = get_attr_value(node, 'sizes');
				const width = get_attr_value(node, 'width');
				url += url.includes('?') ? '&' : '?';
				if (sizes) {
					url += 'imgSizes=' + encodeURIComponent(sizes.raw) + '&';
				}
				if (width) {
					url += 'imgWidth=' + encodeURIComponent(width.raw) + '&';
				}
				url += 'enhanced';

				let details = images.get(url);
				if (!details) {
					const image = await resolve(opts, url, filename);
					if (!image) {
						return;
					}
					details = images.get(url) || { name: ASSET_PREFIX + images.size, image };
					images.set(url, details);
				}

				if (OPTIMIZABLE.test(url)) {
					s.update(node.start, node.end, img_to_picture(content, node, details.name));
				} else {
					// e.g. <img src="./foo.svg" /> => <img src="{___ASSET___0}" />
					s.update(src_attribute.start, src_attribute.end, `{${details}}`);
				}
			}

			// TODO: switch to zimmerframe with Svelte 5
			// @ts-ignore
			await asyncWalk(ast.html, {
				/**
				 * @param {import('svelte/types/compiler/interfaces').TemplateNode} node
				 */
				async enter(node) {
					if (node.type === 'Element') {
						// Compare node tag match
						if (node.name === 'enhanced:img') {
							const src = get_attr_value(node, 'src');
							if (!src) return;
							await update_element(node, src);
						}
					}
				}
			});

			// add hoisted consts
			if (images.size) {
				let const_text = '';
				for (const details of images.values()) {
					const_text += `const ${details.name} = ${JSON.stringify(details.image)};`;
				}
				if (ast.instance) {
					// @ts-ignore
					s.appendLeft(ast.instance.content.start, const_text);
				} else {
					s.append(`<script>${const_text}</script>`);
				}
			}

			return {
				code: s.toString(),
				map: s.generateMap()
			};
		}
	};
}

/**
 * @param {{
*   plugin_context: import('rollup').PluginContext
*   imagetools_plugin: import('vite').Plugin
* }} opts
 * @param {string} url
 * @param {string | undefined} importer
 * @returns {Promise<import('vite-imagetools').Picture | undefined>}
 */
async function resolve(opts, url, importer) {
	const resolved = await opts.plugin_context.resolve(url, importer);
	const id = resolved?.id;
	if (!id) {
		return;
	}
	if (!opts.imagetools_plugin.load) {
		throw new Error('Invalid instance of vite-imagetools. Could not find load method.');
	}
	const hook = opts.imagetools_plugin.load;
	const handler = typeof hook === 'object' ? hook.handler : hook;
	const module_info = await handler.call(opts.plugin_context, id);
	if (!module_info) {
		throw new Error(`Could not load ${id}`);
	}
	const code = typeof module_info === 'string' ? module_info : module_info.code;
	return parseObject(code.replace('export default', '').replace(/;$/, ''));
}

/**
 * @param {string} str
 */
export function parseObject(str) {
	return JSON.parse(str.replaceAll('{', '{"').replaceAll(':', '":').replaceAll(/,([^ ])/g, ',"$1'));
}

/**
 * @param {import('svelte/types/compiler/interfaces').TemplateNode} node
 * @param {string} attr
 */
function get_attr_value(node, attr) {
	const attribute = node.attributes.find(
		/** @param {any} v */ (v) => v.type === 'Attribute' && v.name === attr
	);

	if (!attribute) return;

	return attribute.value[0];
}

/**
 * @param {string} content
 * @param {Array<import('svelte/types/compiler/interfaces').BaseDirective | import('svelte/types/compiler/interfaces').Attribute | import('svelte/types/compiler/interfaces').SpreadAttribute>} attributes
 * @param {string} src_var_name
 */
function attributes_to_markdown(content, attributes, src_var_name) {
	const attribute_strings = attributes.map((attribute) => {
		if (attribute.name === 'src') {
			return `src={${src_var_name}.img.src}`;
		}
		return content.substring(attribute.start, attribute.end);
	});

	let has_width = false;
	let has_height = false;
	for (const attribute of attributes) {
		if (attribute.name === 'width') has_width = true;
		if (attribute.name === 'height') has_height = true;
	}
	if (!has_width && !has_height) {
		attribute_strings.push(`imgWidth={${src_var_name}.img.w}`);
		attribute_strings.push(`imgHeight={${src_var_name}.img.h}`);
	}

	return attribute_strings.join(' ');
}

/**
 * @param {string} content
 * @param {import('svelte/types/compiler/interfaces').TemplateNode} node
 * @param {string} var_name
 */
function img_to_picture(content, node, var_name) {
	/** @type {Array<import('svelte/types/compiler/interfaces').BaseDirective | import('svelte/types/compiler/interfaces').Attribute | import('svelte/types/compiler/interfaces').SpreadAttribute>} attributes */
	const attributes = node.attributes;
	const index = attributes.findIndex((attribute) => attribute.name === 'sizes');
	let sizes_string = '';
	if (index >= 0) {
		sizes_string = content.substring(attributes[index].start, attributes[index].end);
		attributes.splice(index, 1);
	}

	return `<picture>
	{#each Object.entries(${var_name}.sources) as [format, srcset]}
		<source {srcset}${sizes_string} type={'image/' + format} />
	{/each}
	<img ${attributes_to_markdown(content, attributes, var_name)} />
</picture>`;
}

/**
 * For images like `<img src={manually_imported} />`
 * @param {string} content
 * @param {import('svelte/types/compiler/interfaces').TemplateNode} node
 * @param {string} src_var_name
 */
function dynamic_img_to_picture(content, node, src_var_name) {
	return `{#if typeof ${src_var_name} === 'string'}
	<img ${attributes_to_markdown(content, node.attributes, src_var_name)} />
{:else}
	${img_to_picture(content, node, src_var_name)}
{/if}`;
}
