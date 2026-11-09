/**
 * ── CATALOGUE ──────────────────────────────────────────────────────────────────
 * Sample products until the real ones (and the server that will hold them) arrive. Every
 * picture is a cut-out of the cabin's own painting (tools/cut-samples.py), so the shop reads
 * as part of the room. To go live, replace PRODUCTS with what the server returns — the shop
 * only needs these fields.
 *
 *   collection  which hotspot it hangs on: 'shelf' or 'rack'
 *   price       whole units of CURRENCY
 *   colours     [ name, swatch ] — the first is the one pictured
 *   sizes       what can be chosen; a single entry is shown as fixed, not as a choice
 */

export const CURRENCY = {
	code: 'IRT',
	format: amount => `${ Math.round( amount ).toLocaleString( 'en-US' ) } Toman`
};

export const COLLECTIONS = {
	shelf: {
		kicker: 'Caps & beanies',
		title: 'The shelf',
		blurb: 'Six-panel caps in washed cotton and wool beanies knitted for the cold mornings up the valley.'
	},
	rack: {
		kicker: 'Coats & shirts',
		title: 'The rack',
		blurb: 'Field jackets, overshirts and coats cut for walking out in weather and coming back in to the fire.'
	}
};

const HATS = [ 'One size' ];
const GARMENTS = [ 'S', 'M', 'L', 'XL' ];

export const PRODUCTS = [
	{
		id: 'cap-meadow', collection: 'shelf', name: 'Meadow Cap', price: 1450000,
		image: 'assets/shop/cap-meadow.webp',
		colours: [ [ 'Sand & sky', '#d9c7a4' ], [ 'Moss', '#6d7a4a' ] ],
		sizes: HATS,
		description: 'A six-panel cap in washed cotton twill, with a sky-blue brim and a stitched peak badge.',
		details: [ '100% cotton twill', 'Adjustable strap', 'Embroidered badge' ]
	},
	{
		id: 'cap-moss', collection: 'shelf', name: 'Moss Cap', price: 1450000,
		image: 'assets/shop/cap-moss.webp',
		colours: [ [ 'Moss', '#6d7a4a' ], [ 'Sand', '#d9c7a4' ] ],
		sizes: HATS,
		description: 'The meadow cap in the green of the slope behind the cabin, with a woven label on the front.',
		details: [ '100% cotton twill', 'Adjustable strap', 'Woven label' ]
	},
	{
		id: 'beanie-stack', collection: 'shelf', name: 'Trail Beanie', price: 990000,
		image: 'assets/shop/beanie-stack.webp',
		colours: [ [ 'Rust', '#b9643a' ], [ 'Sky', '#4f7fb3' ], [ 'Pine', '#3d6a58' ], [ 'Plum', '#7a4450' ] ],
		sizes: HATS,
		description: 'A plain rib beanie, folded once. Four colours, stacked on the shelf like this one.',
		details: [ 'Merino blend', 'Double-folded cuff', 'Machine washable' ]
	},
	{
		id: 'beanie-dusk', collection: 'shelf', name: 'Dusk Beanie', price: 1050000,
		image: 'assets/shop/beanie-dusk.webp',
		colours: [ [ 'Dusk navy', '#34405a' ] ],
		sizes: HATS,
		description: 'A close-fitting navy watch beanie with a deep cuff and a small leather tab.',
		details: [ 'Merino blend', 'Leather tab', 'Deep cuff' ]
	},
	{
		id: 'beanie-summit', collection: 'shelf', name: 'Summit Pom Beanie', price: 1190000,
		image: 'assets/shop/beanie-summit.webp',
		colours: [ [ 'Glacier', '#4b6a92' ] ],
		sizes: HATS,
		description: 'Chunky cable rib, a grey cuff and a pom as white as the top of Damavand.',
		details: [ 'Wool blend', 'Faux-fur pom', 'Chunky rib' ]
	},
	{
		id: 'beanie-alpine', collection: 'shelf', name: 'Alpine Fair Isle', price: 1290000,
		image: 'assets/shop/beanie-alpine.webp',
		colours: [ [ 'Night & cream', '#2f3d5f' ] ],
		sizes: HATS,
		description: 'A fair isle beanie knitted in two colours, with a wave of peaks around the band.',
		details: [ 'Lambswool', 'Jacquard knit', 'Fleece-lined band' ]
	},
	{
		id: 'parka-night', collection: 'rack', name: 'Night Parka', price: 8900000,
		image: 'assets/shop/parka-night.webp',
		colours: [ [ 'Night', '#33406a' ], [ 'Fern', '#4c6b4e' ] ],
		sizes: GARMENTS,
		description: 'A long padded parka with a fleece-lined hood, for the walk down after dark.',
		details: [ 'Water-repellent shell', 'Recycled fill', 'Fleece-lined hood' ]
	},
	{
		id: 'jacket-fern', collection: 'rack', name: 'Fern Field Jacket', price: 6400000,
		image: 'assets/shop/jacket-fern.webp',
		colours: [ [ 'Fern', '#4c6b4e' ], [ 'Rust', '#a4532f' ] ],
		sizes: GARMENTS,
		description: 'A four-pocket field jacket in waxed cotton that softens the more it is worn.',
		details: [ 'Waxed cotton', 'Four bellows pockets', 'Corduroy collar' ]
	},
	{
		id: 'overshirt-sand', collection: 'rack', name: 'Sand Overshirt', price: 3800000,
		image: 'assets/shop/overshirt-sand.webp',
		colours: [ [ 'Sand', '#cdb88c' ], [ 'Slate', '#5c6470' ] ],
		sizes: GARMENTS,
		description: 'A heavy brushed-cotton overshirt, worn open over a tee or buttoned up as a light jacket.',
		details: [ 'Brushed cotton', 'Two chest pockets', 'Horn buttons' ]
	},
	{
		id: 'shirt-cloud', collection: 'rack', name: 'Cloud Oxford Shirt', price: 2600000,
		image: 'assets/shop/shirt-cloud.webp',
		colours: [ [ 'Cloud', '#e4e0d6' ], [ 'Sky', '#9fb5cf' ] ],
		sizes: GARMENTS,
		description: 'An oxford shirt in a soft off-white, with a button-down collar and a relaxed cut.',
		details: [ 'Oxford cotton', 'Button-down collar', 'Relaxed fit' ]
	},
	{
		id: 'coat-heather', collection: 'rack', name: 'Heather Wool Coat', price: 9800000,
		image: 'assets/shop/coat-heather.webp',
		colours: [ [ 'Heather', '#6e4a52' ] ],
		sizes: GARMENTS,
		description: 'A single-breasted wool coat in the heather of the hillside at dusk.',
		details: [ 'Wool blend', 'Half-lined', 'Notch lapel' ]
	},
	{
		id: 'jacket-ember', collection: 'rack', name: 'Ember Work Jacket', price: 7200000,
		image: 'assets/shop/jacket-ember.webp',
		colours: [ [ 'Ember', '#b0663a' ], [ 'Night', '#33406a' ] ],
		sizes: GARMENTS,
		description: 'A duck-canvas work jacket in a burnt orange, with a lined hood and a leather patch.',
		details: [ 'Duck canvas', 'Quilted lining', 'Leather patch' ]
	}
];

export const productById = id => PRODUCTS.find( product => product.id === id ) || null;
export const productsIn = collection => PRODUCTS.filter( product => product.collection === collection );

/** Shipping, chosen at checkout. */
export const SHIPPING = [
	{ id: 'post', name: 'Post', note: '3–5 working days', price: 90000 },
	{ id: 'courier', name: 'Courier', note: 'Tehran, next day', price: 180000 }
];
