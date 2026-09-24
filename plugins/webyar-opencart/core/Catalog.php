<?php
namespace WebYar\OpenCart;

/**
 * Public catalogue reads, answered straight from the store's database with
 * bounded, paginated queries — there is no product index on Web Yar's side.
 *
 * Cost model (verified in tests/integration, reported per response in
 * `_meta.db`):
 *   search      1 query (+1 when a category or manufacturer is named by text)
 *   get         2 queries for up to 10 ids (products, options) + 1 for
 *               attributes + 1 for quantity discounts when ONE id is asked
 *   reviews     2 queries (product visibility + page of reviews and totals)
 *   categories  1 query
 * No query runs per result row from PHP (no N+1), no call reads the whole
 * catalogue into PHP, and totals are never COUNTed unless asked for
 * (`count_total`), because `has_more` from a page_size+1 read is free.
 *
 * Visibility is exactly the storefront's: enabled, date_available passed,
 * assigned to THIS store, described in the chosen language. Prices come from
 * the store's own price SQL for the effective customer group, then OpenCart's
 * own Tax and Currency objects — never a conversion or rounding of ours.
 */
final class Catalog {
	private Db $db;
	private Platform $platform;
	private Context $ctx;
	/** @var array<string,bool|string> */
	private array $schema;

	public function __construct(Db $db, Platform $platform, Context $ctx, array $schema) {
		$this->db = $db;
		$this->platform = $platform;
		$this->ctx = $ctx;
		$this->schema = $schema;
	}

	/** @return array<string,mixed> */
	public function search(array $in): array {
		$page = max(1, min(100, (int)($in['page'] ?? 1)));
		$size = max(1, min(Protocol::MAX_PAGE_SIZE, (int)($in['page_size'] ?? 5)));
		$terms = Text::terms($in['terms'] ?? []);
		$applied = [];
		$unsupported = [];

		$where = $this->visibleWhere();
		$score = '0';

		if ($terms) {
			$conditions = [];
			$scores = [];
			foreach ($terms as $term) {
				$variants = Text::variants($term);
				$name = [];
				$tag = [];

				foreach ($variants as $v) {
					$name[] = '`pd`.`name` LIKE ' . $this->db->like($v);
					$tag[] = '`pd`.`tag` LIKE ' . $this->db->like($v);
				}

				// Shoppers ask by category («چه گوشی‌هایی دارید؟») far more
				// often than by a word in a product name: a term naming one of
				// this store's visible categories (or a parent) matches its
				// products too, ranked with tags. A subquery, not a round trip.
				$weak = $tag;
				$weak[] = '`p`.`product_id` IN (SELECT `p2c`.`product_id` FROM ' . $this->db->t('product_to_category') . ' `p2c` INNER JOIN ' . $this->db->t('category_path') . ' `cp` ON (`cp`.`category_id` = `p2c`.`category_id`) INNER JOIN ' . $this->db->t('category_description') . ' `cd` ON (`cd`.`category_id` = `cp`.`path_id` AND `cd`.`language_id` = ' . $this->ctx->languageId . ') INNER JOIN ' . $this->db->t('category') . ' `c` ON (`c`.`category_id` = `cp`.`path_id` AND `c`.`status` = 1) INNER JOIN ' . $this->db->t('category_to_store') . ' `c2s` ON (`c2s`.`category_id` = `cp`.`path_id` AND `c2s`.`store_id` = ' . $this->ctx->storeId . ') WHERE ' . implode(' OR ', array_map(fn ($v) => '`cd`.`name` LIKE ' . $this->db->like($v), $variants)) . ')';

				$exact = '`p`.`model` = ' . $this->db->str($term) . $this->skuMatch($term);
				$conditions[] = '(' . implode(' OR ', array_merge($name, $weak)) . ' OR ' . $exact . ')';
				$scores[] = '(CASE WHEN ' . $exact . ' THEN 5 WHEN ' . implode(' OR ', $name) . ' THEN 2 WHEN ' . implode(' OR ', $weak) . ' THEN 1 ELSE 0 END)';
			}


			// OR across terms and rank by how many matched: a shopper's
			// sentence («یه هدفون خوب معرفی کن») never has every word in a name.
			$where[] = '(' . implode(' OR ', $conditions) . ')';
			$score = implode(' + ', $scores);
			$applied['terms'] = $terms;
		}

		$categoryIds = $this->resolveCategories($in);

		if ($categoryIds !== null) {
			if (!$categoryIds) {
				return $this->emptyPage($page, $size, $applied + ['category' => 'not_found'], $unsupported);
			}

			$where[] = '`p`.`product_id` IN (SELECT `p2c`.`product_id` FROM ' . $this->db->t('product_to_category') . ' `p2c` INNER JOIN ' . $this->db->t('category_path') . ' `cp` ON (`cp`.`category_id` = `p2c`.`category_id`) WHERE `cp`.`path_id` IN (' . Db::intList($categoryIds) . '))';
			$applied['category_ids'] = $categoryIds;
		}

		$manufacturerIds = $this->resolveManufacturers($in);

		if ($manufacturerIds !== null) {
			if (!$manufacturerIds) {
				return $this->emptyPage($page, $size, $applied + ['manufacturer' => 'not_found'], $unsupported);
			}

			$where[] = '`p`.`manufacturer_id` IN (' . Db::intList($manufacturerIds) . ')';
			$applied['manufacturer_ids'] = $manufacturerIds;
		}

		if (!empty($in['in_stock_only'])) {
			$where[] = '`p`.`quantity` > 0';
			$applied['in_stock_only'] = true;
		}

		$having = [];
		$effective = 'COALESCE(`special`, `discount`, `p`.`price`)';

		foreach (['min_price' => '>=', 'max_price' => '<='] as $key => $op) {
			if (isset($in[$key]) && is_numeric($in[$key]) && (float)$in[$key] >= 0) {
				if (!$this->ctx->pricesVisible) {
					$unsupported[] = $key . ':prices_hidden_for_guests';
					continue;
				}

				// The shopper's amount is in the DISPLAY currency; the column is
				// in the store's default currency, before tax.
				$rate = $this->platform->currencies()[$this->ctx->currency]['value'] ?? 1.0;
				$having[] = $effective . ' ' . $op . ' ' . number_format((float)$in[$key] / ($rate ?: 1.0), 6, '.', '');
				$applied[$key] = (string)$in[$key];
				$applied['price_filter_basis'] = 'before_tax';
			}
		}

		if (!empty($in['attributes']) && is_array($in['attributes'])) {
			// OpenCart attributes are free text per product, and options are
			// not variations: matching "size=43" reliably needs the product
			// itself. Reported rather than silently dropped.
			$unsupported[] = 'attributes';
		}

		$order = $this->orderBy((string)($in['sort'] ?? ''), $terms !== []);
		$sql = 'SELECT ' . $this->summaryColumns() . ', (' . $score . ') AS `score`' . $this->fromVisible() . ' WHERE ' . implode(' AND ', $where)
			. ($having ? ' HAVING ' . implode(' AND ', $having) : '')
			. ' ORDER BY ' . $order . ' LIMIT ' . (($page - 1) * $size) . ',' . ($size + 1);

		$rows = $this->db->rows($sql);
		$hasMore = count($rows) > $size;
		$rows = array_slice($rows, 0, $size);

		$result = [
			'products'            => array_map([$this, 'summary'], $rows),
			'page'                => $page,
			'page_size'           => $size,
			'has_more'            => $hasMore,
			'applied_filters'     => $applied,
			'unsupported_filters' => $unsupported,
			'search_mode'         => 'store_sql_like',
		];

		if (!empty($in['count_total']) && !$having) {
			$count = $this->db->row('SELECT COUNT(*) AS `total`' . $this->fromVisible() . ' WHERE ' . implode(' AND ', $where));
			$result['total'] = (int)($count['total'] ?? 0);
		}

		return $result;
	}

	/** @return array<string,mixed> */
	public function get(array $in): array {
		$ids = array_slice(array_values(array_unique(array_filter(array_map('intval', (array)($in['ids'] ?? [])), fn ($id) => $id > 0))), 0, Protocol::MAX_IDS);

		if (!$ids) {
			throw new ApiError('invalid_request', 422);
		}

		$where = $this->visibleWhere();
		$where[] = '`p`.`product_id` IN (' . Db::intList($ids) . ')';

		$rows = $this->db->rows('SELECT ' . $this->summaryColumns() . ', `pd`.`description`, ' . $this->specialEndColumn() . $this->fromVisible() . ' WHERE ' . implode(' AND ', $where) . ' LIMIT ' . count($ids));

		$byId = [];

		foreach ($rows as $row) {
			$byId[(int)$row['product_id']] = $row;
		}

		$found = array_keys($byId);
		$options = $found ? $this->options($found, $byId) : [];
		$attributes = $found ? $this->attributes($found) : [];
		$discounts = (count($found) === 1 && $this->ctx->pricesVisible) ? $this->quantityDiscounts($byId[$found[0]]) : [];

		$products = [];

		foreach ($ids as $id) {
			if (!isset($byId[$id])) {
				continue;
			}

			$row = $byId[$id];
			$product = $this->summary($row);
			$product['description'] = Text::clean($row['description'] ?? '', 700);
			$product['options'] = $options[$id] ?? [];
			$product['attributes'] = $attributes[$id] ?? [];
			$product['minimum'] = max(1, (int)$row['minimum']);

			if ($this->ctx->pricesVisible && !empty($row['special_end']) && $row['special'] !== null && $row['special_end'] !== '0000-00-00') {
				$product['special_ends'] = (string)$row['special_end'];
			}

			if (count($found) === 1) {
				$product['quantity_discounts'] = $discounts;
			}

			// Required options whose every value is unavailable make the whole
			// product unorderable — the storefront shows its stock status.
			foreach ($product['options'] as $option) {
				if ($option['required'] && $option['has_values'] && !$option['values']) {
					$product['stock']['state'] = $this->platform->config('config_stock_checkout') ? 'backorder' : 'out_of_stock';
					$product['stock']['text'] = Text::clean($row['stock_status'] ?? '', 60);
					unset($product['stock']['quantity']);
				}
			}

			$products[] = $product;
		}

		return ['products' => $products, 'not_found' => array_values(array_diff($ids, $found))];
	}

	/** @return array<string,mixed> */
	public function reviews(array $in): array {
		$id = (int)($in['product_id'] ?? 0);
		$page = max(1, min(50, (int)($in['page'] ?? 1)));
		$size = max(1, min(Protocol::MAX_REVIEWS, (int)($in['page_size'] ?? 3)));

		$where = $this->visibleWhere();
		$where[] = '`p`.`product_id` = ' . $id;

		// One query: visibility + totals. The review page is a second one.
		$head = $this->db->row('SELECT `p`.`product_id`, `pd`.`name`, (SELECT COUNT(*) FROM ' . $this->db->t('review') . ' `r` WHERE `r`.`product_id` = `p`.`product_id` AND `r`.`status` = 1) AS `review_count`, (SELECT AVG(`r2`.`rating`) FROM ' . $this->db->t('review') . ' `r2` WHERE `r2`.`product_id` = `p`.`product_id` AND `r2`.`status` = 1) AS `rating`' . $this->fromVisible() . ' WHERE ' . implode(' AND ', $where) . ' LIMIT 1');

		if (!$head || $id <= 0) {
			throw new ApiError('product_not_found', 404);
		}

		$rows = (int)$head['review_count'] > 0
			? $this->db->rows('SELECT `author`, `rating`, `text`, `date_added` FROM ' . $this->db->t('review') . ' WHERE `product_id` = ' . $id . ' AND `status` = 1 ORDER BY `date_added` DESC LIMIT ' . (($page - 1) * $size) . ',' . $size)
			: [];

		return [
			'product_id'     => (string)$id,
			'product_name'   => Text::clean($head['name'], 200),
			'average_rating' => $head['rating'] !== null ? round((float)$head['rating'], 1) : null,
			'review_count'   => (int)$head['review_count'],
			'page'           => $page,
			'page_size'      => $size,
			'has_more'       => $page * $size < (int)$head['review_count'],
			// Approved reviews only, and only what the product page already
			// shows: the display name the reviewer typed, the rating, the text
			// and the date. Never customer_id, email or IP.
			'reviews'        => array_map(fn ($r) => [
				'author' => Text::clean($r['author'], 60),
				'rating' => (int)$r['rating'],
				'text'   => Text::clean($r['text'], 500),
				'date'   => substr((string)$r['date_added'], 0, 10),
			], $rows),
		];
	}

	/** @return array<string,mixed> */
	public function categories(array $in): array {
		$parent = max(0, (int)($in['parent_id'] ?? 0));
		$rows = $this->db->rows('SELECT `c`.`category_id`, `cd`.`name` FROM ' . $this->db->t('category') . ' `c` INNER JOIN ' . $this->db->t('category_description') . ' `cd` ON (`cd`.`category_id` = `c`.`category_id` AND `cd`.`language_id` = ' . $this->ctx->languageId . ') INNER JOIN ' . $this->db->t('category_to_store') . ' `c2s` ON (`c2s`.`category_id` = `c`.`category_id` AND `c2s`.`store_id` = ' . $this->ctx->storeId . ') WHERE `c`.`status` = 1 AND `c`.`parent_id` = ' . $parent . ' ORDER BY `c`.`sort_order`, `cd`.`name` LIMIT 31');

		return [
			'categories' => array_map(fn ($r) => [
				'id'   => (string)$r['category_id'],
				'name' => Text::clean($r['name'], 120),
				'url'  => $this->platform->link('product/category', ['path' => (int)$r['category_id']]),
			], array_slice($rows, 0, 30)),
			'has_more'   => count($rows) > 30,
		];
	}

	// ── building blocks ────────────────────────────────────────────────

	/** @return string[] */
	private function visibleWhere(): array {
		return [
			'`p2s`.`store_id` = ' . $this->ctx->storeId,
			'`p`.`status` = 1',
			'`p`.`date_available` <= NOW()',
		];
	}

	private function fromVisible(): string {
		return ' FROM ' . $this->db->t('product_to_store') . ' `p2s`'
			. ' INNER JOIN ' . $this->db->t('product') . ' `p` ON (`p`.`product_id` = `p2s`.`product_id`)'
			. ' INNER JOIN ' . $this->db->t('product_description') . ' `pd` ON (`pd`.`product_id` = `p`.`product_id` AND `pd`.`language_id` = ' . $this->ctx->languageId . ')'
			. ' LEFT JOIN ' . $this->db->t('manufacturer') . ' `m` ON (`m`.`manufacturer_id` = `p`.`manufacturer_id`)'
			. ' LEFT JOIN ' . $this->db->t('stock_status') . ' `ss` ON (`ss`.`stock_status_id` = `p`.`stock_status_id` AND `ss`.`language_id` = ' . $this->ctx->languageId . ')';
	}

	private function summaryColumns(): string {
		$statements = $this->platform->priceStatements();

		return '`p`.`product_id`, `p`.`model`, `p`.`image`, `p`.`quantity`, `p`.`price`, `p`.`tax_class_id`, `p`.`minimum`, `p`.`date_added`, `p`.`sort_order`, `pd`.`name`, `m`.`name` AS `manufacturer`, `ss`.`name` AS `stock_status`, '
			. $statements['discount'] . ', ' . $statements['special']
			. ', (SELECT AVG(`rv`.`rating`) FROM ' . $this->db->t('review') . ' `rv` WHERE `rv`.`product_id` = `p`.`product_id` AND `rv`.`status` = 1) AS `rating`'
			. ', (SELECT COUNT(*) FROM ' . $this->db->t('review') . ' `rc` WHERE `rc`.`product_id` = `p`.`product_id` AND `rc`.`status` = 1) AS `reviews`'
			. ', (SELECT COUNT(*) FROM ' . $this->db->t('product_option') . ' `po` WHERE `po`.`product_id` = `p`.`product_id`) AS `option_count`';
	}

	private function specialEndColumn(): string {
		$group = $this->ctx->customerGroupId;
		$active = "((`x`.`date_start` = '0000-00-00' OR `x`.`date_start` < NOW()) AND (`x`.`date_end` = '0000-00-00' OR `x`.`date_end` > NOW()))";

		if (!empty($this->schema['product_special'])) {
			return '(SELECT `x`.`date_end` FROM ' . $this->db->t('product_special') . ' `x` WHERE `x`.`product_id` = `p`.`product_id` AND `x`.`customer_group_id` = ' . $group . ' AND ' . $active . ' ORDER BY `x`.`priority` ASC, `x`.`price` ASC LIMIT 1) AS `special_end`';
		}

		return '(SELECT `x`.`date_end` FROM ' . $this->db->t('product_discount') . ' `x` WHERE `x`.`product_id` = `p`.`product_id` AND `x`.`customer_group_id` = ' . $group . " AND `x`.`quantity` = '1' AND `x`.`special` = '1' AND " . $active . ' ORDER BY `x`.`priority` ASC, `x`.`price` ASC LIMIT 1) AS `special_end`';
	}

	private function skuMatch(string $term): string {
		if (!empty($this->schema['product_code'])) {
			return ' OR EXISTS (SELECT 1 FROM ' . $this->db->t('product_code') . ' `pc` WHERE `pc`.`product_id` = `p`.`product_id` AND `pc`.`value` = ' . $this->db->str($term) . ')';
		}

		if (!empty($this->schema['product_sku'])) {
			return ' OR `p`.`sku` = ' . $this->db->str($term);
		}

		return '';
	}

	private function orderBy(string $sort, bool $hasTerms): string {
		switch ($sort) {
			case 'price_asc':
				return 'COALESCE(`special`, `discount`, `p`.`price`) ASC, `p`.`product_id` ASC';
			case 'price_desc':
				return 'COALESCE(`special`, `discount`, `p`.`price`) DESC, `p`.`product_id` ASC';
			case 'newest':
				return '`p`.`date_added` DESC, `p`.`product_id` DESC';
			case 'rating':
				return '`rating` DESC, `p`.`product_id` ASC';
			default:
				// The storefront's own default order, relevance first.
				return ($hasTerms ? '`score` DESC, ' : '') . '`p`.`sort_order` ASC, LCASE(`pd`.`name`) ASC, `p`.`product_id` ASC';
		}
	}

	/** @return int[]|null null = no category filter requested */
	private function resolveCategories(array $in): ?array {
		if (!empty($in['category_id'])) {
			$id = (int)$in['category_id'];
			$row = $this->db->row('SELECT `c`.`category_id` FROM ' . $this->db->t('category') . ' `c` INNER JOIN ' . $this->db->t('category_to_store') . ' `c2s` ON (`c2s`.`category_id` = `c`.`category_id` AND `c2s`.`store_id` = ' . $this->ctx->storeId . ') WHERE `c`.`category_id` = ' . $id . ' AND `c`.`status` = 1 LIMIT 1');

			return $row ? [$id] : [];
		}

		$name = Text::clean($in['category'] ?? '', 60);

		if ($name === '') {
			return null;
		}

		$rows = $this->db->rows('SELECT `c`.`category_id` FROM ' . $this->db->t('category_description') . ' `cd` INNER JOIN ' . $this->db->t('category') . ' `c` ON (`c`.`category_id` = `cd`.`category_id` AND `c`.`status` = 1) INNER JOIN ' . $this->db->t('category_to_store') . ' `c2s` ON (`c2s`.`category_id` = `c`.`category_id` AND `c2s`.`store_id` = ' . $this->ctx->storeId . ') WHERE `cd`.`language_id` = ' . $this->ctx->languageId . ' AND `cd`.`name` LIKE ' . $this->db->like($name) . ' LIMIT 3');

		return array_map(fn ($r) => (int)$r['category_id'], $rows);
	}

	/** @return int[]|null */
	private function resolveManufacturers(array $in): ?array {
		$name = Text::clean($in['manufacturer'] ?? '', 60);

		if ($name === '') {
			return null;
		}

		$rows = $this->db->rows('SELECT `m`.`manufacturer_id` FROM ' . $this->db->t('manufacturer') . ' `m` INNER JOIN ' . $this->db->t('manufacturer_to_store') . ' `m2s` ON (`m2s`.`manufacturer_id` = `m`.`manufacturer_id` AND `m2s`.`store_id` = ' . $this->ctx->storeId . ') WHERE `m`.`name` LIKE ' . $this->db->like($name) . ' LIMIT 3');

		return array_map(fn ($r) => (int)$r['manufacturer_id'], $rows);
	}

	/** @return array<int,array<int,array<string,mixed>>> product_id => options */
	private function options(array $ids, array $byId): array {
		$rows = $this->db->rows('SELECT `po`.`product_id`, `po`.`product_option_id`, `po`.`required`, `o`.`type`, `od`.`name` AS `option_name`, `pov`.`product_option_value_id`, `pov`.`quantity`, `pov`.`subtract`, `pov`.`price`, `pov`.`price_prefix`, `ovd`.`name` AS `value_name`'
			. ' FROM ' . $this->db->t('product_option') . ' `po`'
			. ' INNER JOIN ' . $this->db->t('option') . ' `o` ON (`o`.`option_id` = `po`.`option_id`)'
			. ' INNER JOIN ' . $this->db->t('option_description') . ' `od` ON (`od`.`option_id` = `po`.`option_id` AND `od`.`language_id` = ' . $this->ctx->languageId . ')'
			. ' LEFT JOIN ' . $this->db->t('product_option_value') . ' `pov` ON (`pov`.`product_option_id` = `po`.`product_option_id`)'
			. ' LEFT JOIN ' . $this->db->t('option_value') . ' `ov` ON (`ov`.`option_value_id` = `pov`.`option_value_id`)'
			. ' LEFT JOIN ' . $this->db->t('option_value_description') . ' `ovd` ON (`ovd`.`option_value_id` = `pov`.`option_value_id` AND `ovd`.`language_id` = ' . $this->ctx->languageId . ')'
			. ' WHERE `po`.`product_id` IN (' . Db::intList($ids) . ')'
			. ' ORDER BY `po`.`product_id`, `o`.`sort_order`, `po`.`product_option_id`, `ov`.`sort_order`'
			. ' LIMIT 400');

		$out = [];

		foreach ($rows as $r) {
			$pid = (int)$r['product_id'];
			$oid = (int)$r['product_option_id'];

			if (!isset($out[$pid][$oid])) {
				$out[$pid][$oid] = [
					'id'         => (string)$oid,
					'name'       => Text::clean($r['option_name'], 80),
					'type'       => (string)$r['type'],
					'required'   => (bool)$r['required'],
					'has_values' => in_array($r['type'], ['select', 'radio', 'checkbox', 'image'], true),
					'values'     => [],
				];
			}

			if ($r['product_option_value_id'] === null || count($out[$pid][$oid]['values']) >= 40) {
				continue;
			}

			// The storefront offers a value only while it is not stock-tracked
			// or still has stock; anything else is not on the product page and
			// is not offered here either. Option quantities are never exposed —
			// OpenCart does not show them to shoppers.
			if ((int)$r['subtract'] && (int)$r['quantity'] <= 0) {
				continue;
			}

			$value = ['id' => (string)$r['product_option_value_id'], 'name' => Text::clean($r['value_name'], 80)];

			if ($this->ctx->pricesVisible && (float)$r['price']) {
				$product = $byId[$pid];
				$delta = $this->platform->withTax((float)$r['price'], (int)$product['tax_class_id']);
				$value['price_delta'] = (string)$r['price_prefix'] . $this->platform->formatMoney($delta, $this->ctx->currency);
			}

			$out[$pid][$oid]['values'][] = $value;
		}

		return array_map('array_values', $out);
	}

	/** @return array<int,array<int,array{name:string,value:string}>> */
	private function attributes(array $ids): array {
		$rows = $this->db->rows('SELECT `pa`.`product_id`, `ad`.`name`, `pa`.`text` FROM ' . $this->db->t('product_attribute') . ' `pa` INNER JOIN ' . $this->db->t('attribute') . ' `a` ON (`a`.`attribute_id` = `pa`.`attribute_id`) INNER JOIN ' . $this->db->t('attribute_description') . ' `ad` ON (`ad`.`attribute_id` = `pa`.`attribute_id` AND `ad`.`language_id` = ' . $this->ctx->languageId . ') WHERE `pa`.`product_id` IN (' . Db::intList($ids) . ') AND `pa`.`language_id` = ' . $this->ctx->languageId . ' ORDER BY `pa`.`product_id`, `a`.`sort_order` LIMIT 200');
		$out = [];

		foreach ($rows as $r) {
			if (count($out[(int)$r['product_id']] ?? []) < 20) {
				$out[(int)$r['product_id']][] = ['name' => Text::clean($r['name'], 80), 'value' => Text::clean($r['text'], 160)];
			}
		}

		return $out;
	}

	/** Quantity tiers through the store's OWN model method (semantics differ between versions). */
	private function quantityDiscounts(array $row): array {
		$tiers = [];

		foreach (array_slice($this->platform->quantityDiscounts((int)$row['product_id']), 0, 5) as $d) {
			$gross = $this->platform->withTax((float)$d['price'], (int)$row['tax_class_id']);
			$tiers[] = ['min_quantity' => (int)$d['quantity'], 'unit_price' => $this->money($gross)];
		}

		return $tiers;
	}

	/** @return array<string,mixed> */
	private function summary(array $row): array {
		$id = (int)$row['product_id'];
		$quantity = (int)$row['quantity'];
		$stockCheckout = (bool)$this->platform->config('config_stock_checkout');
		$stock = ['state' => $quantity > 0 ? 'in_stock' : ($stockCheckout ? 'backorder' : 'out_of_stock')];

		if ($quantity <= 0) {
			$stock['text'] = Text::clean($row['stock_status'] ?? '', 60);
		} elseif ($this->platform->config('config_stock_display')) {
			// The store shows exact quantities on its product page; so may we.
			$stock['quantity'] = $quantity;
		}

		$out = [
			'id'           => (string)$id,
			'name'         => Text::clean($row['name'], 200),
			'model'        => Text::clean($row['model'], 64),
			'manufacturer' => $row['manufacturer'] !== null ? Text::clean($row['manufacturer'], 80) : null,
			'url'          => $this->platform->link('product/product', ['product_id' => $id]),
			'image'        => $row['image'] ? $this->platform->imageUrl((string)$row['image']) : null,
			'stock'        => $stock,
			'rating'       => $row['rating'] !== null ? round((float)$row['rating'], 1) : null,
			'review_count' => (int)$row['reviews'],
			'has_options'  => (int)$row['option_count'] > 0,
		];

		if ($this->ctx->pricesVisible) {
			$base = $row['discount'] !== null ? (float)$row['discount'] : (float)$row['price'];
			$out['price'] = $this->money($this->platform->withTax($base, (int)$row['tax_class_id']));

			if ($row['special'] !== null && (float)$row['special'] < $base) {
				$out['special'] = $this->money($this->platform->withTax((float)$row['special'], (int)$row['tax_class_id']));
			}
		} else {
			$out['price_hidden'] = 'login_required';
		}

		return $out;
	}

	/** @return array{amount:string,currency:string,formatted:string,tax_included:bool} */
	private function money(float $defaultCurrencyAmount): array {
		$converted = $this->platform->convertMoney($defaultCurrencyAmount, $this->ctx->currency);
		$places = (int)($this->platform->currencies()[$this->ctx->currency]['decimal_place'] ?? 2);

		return [
			'amount'       => number_format($converted, $places, '.', ''),
			'currency'     => $this->ctx->currency,
			'formatted'    => $this->platform->formatMoney($defaultCurrencyAmount, $this->ctx->currency),
			'tax_included' => $this->ctx->taxDisplay,
		];
	}

	private function emptyPage(int $page, int $size, array $applied, array $unsupported): array {
		return ['products' => [], 'page' => $page, 'page_size' => $size, 'has_more' => false, 'applied_filters' => $applied, 'unsupported_filters' => $unsupported, 'search_mode' => 'store_sql_like'];
	}
}
