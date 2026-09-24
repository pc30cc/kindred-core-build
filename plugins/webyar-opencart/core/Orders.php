<?php
namespace WebYar\OpenCart;

/**
 * The signed-in customer's own orders, read live and minimally.
 *
 * Every read is scoped by customer_id AND the connected store_id AND
 * order_status_id > 0 (OpenCart's own "missing order" rule), in SQL — an
 * order id from anywhere else answers exactly like a non-existent one, so
 * ids cannot be probed. Web Yar's signature is authentication of Web Yar,
 * never authorization for an order; ownership is decided here, every time.
 *
 * Never returned: addresses, e-mail, telephone, IP, user agent, payment
 * details, affiliate/marketing data, admin-only history comments. Payment
 * success and delivery are never inferred from a status: the status NAME is
 * the store's own (translated, possibly custom) text, and its category comes
 * from the store's own "processing" / "complete" status settings.
 */
final class Orders {
	private Db $db;
	private Platform $platform;
	private Context $ctx;
	private array $schema;
	private int $customerId;

	public function __construct(Db $db, Platform $platform, Context $ctx, array $schema, int $customerId) {
		$this->db = $db;
		$this->platform = $platform;
		$this->ctx = $ctx;
		$this->schema = $schema;
		$this->customerId = $customerId;
	}

	/** @return array<string,mixed> */
	public function list(array $in): array {
		$page = max(1, min(100, (int)($in['page'] ?? 1)));
		$size = max(1, min(Protocol::MAX_PAGE_SIZE, (int)($in['page_size'] ?? 5)));

		$rows = $this->db->rows('SELECT `o`.`order_id`, `o`.`order_status_id`, `o`.`total`, `o`.`currency_code`, `o`.`currency_value`, `o`.`date_added`, `o`.`date_modified`, '
			. $this->statusNameColumn('o') . ', '
			. '(SELECT COUNT(*) FROM ' . $this->db->t('order_product') . ' `op` WHERE `op`.`order_id` = `o`.`order_id`) AS `item_count`'
			. ' FROM ' . $this->db->t('order') . ' `o` WHERE ' . $this->scope('o')
			. ' ORDER BY `o`.`order_id` DESC LIMIT ' . (($page - 1) * $size) . ',' . ($size + 1));

		return [
			'orders'    => array_map(fn ($r) => [
				'id'         => (string)$r['order_id'],
				'date_added' => $this->iso($r['date_added']),
				'updated_at' => $this->iso($r['date_modified']),
				'status'     => $this->status((int)$r['order_status_id'], $r['status_name']),
				'total'      => $this->orderMoney((float)$r['total'], $r),
				'item_count' => (int)$r['item_count'],
			], array_slice($rows, 0, $size)),
			'page'      => $page,
			'page_size' => $size,
			'has_more'  => count($rows) > $size,
		];
	}

	/** @return array<string,mixed> */
	public function get(array $in): array {
		$order = $this->owned((int)($in['order_id'] ?? 0));
		$id = (int)$order['order_id'];

		$items = $this->db->rows('SELECT `op`.`order_product_id`, `op`.`product_id`, `op`.`name`, `op`.`model`, `op`.`quantity`, `op`.`price`, `op`.`total`, `op`.`tax` FROM ' . $this->db->t('order_product') . ' `op` WHERE `op`.`order_id` = ' . $id . ' ORDER BY `op`.`order_product_id` LIMIT 51');
		$options = $items ? $this->db->rows('SELECT `order_product_id`, `name`, `value`, `type` FROM ' . $this->db->t('order_option') . ' WHERE `order_id` = ' . $id . ' AND `order_product_id` IN (' . Db::intList(array_column($items, 'order_product_id')) . ') LIMIT 200') : [];
		$totals = $this->db->rows('SELECT `code`, `title`, `value` FROM ' . $this->db->t('order_total') . ' WHERE `order_id` = ' . $id . ' ORDER BY `sort_order` LIMIT 12');
		$history = $this->db->rows('SELECT `oh`.`order_status_id`, `oh`.`notify`, `oh`.`comment`, `oh`.`date_added`, `os`.`name` AS `status_name` FROM ' . $this->db->t('order_history') . ' `oh` LEFT JOIN ' . $this->db->t('order_status') . ' `os` ON (`os`.`order_status_id` = `oh`.`order_status_id` AND `os`.`language_id` = ' . $this->ctx->languageId . ') WHERE `oh`.`order_id` = ' . $id . ' ORDER BY `oh`.`date_added` DESC, `oh`.`order_history_id` DESC LIMIT 20');

		$byItem = [];

		foreach ($options as $o) {
			if ($o['type'] !== 'file') {
				$byItem[(int)$o['order_product_id']][] = Text::clean($o['name'], 60) . ': ' . Text::clean($o['value'], 80);
			}
		}

		// Displayed like the account page: line prices include tax when the
		// store displays prices with tax.
		$withTax = (bool)$this->platform->config('config_tax');

		return [
			'order' => [
				'id'              => (string)$id,
				'date_added'      => $this->iso($order['date_added']),
				'updated_at'      => $this->iso($order['date_modified']),
				'status'          => $this->status((int)$order['order_status_id'], $order['status_name']),
				'currency'        => (string)$order['currency_code'],
				'total'           => $this->orderMoney((float)$order['total'], $order),
				'items'           => array_map(fn ($i) => [
					'product_id' => (string)$i['product_id'],
					'name'       => Text::clean($i['name'], 160),
					'model'      => Text::clean($i['model'], 64),
					'quantity'   => (int)$i['quantity'],
					'options'    => array_slice($byItem[(int)$i['order_product_id']] ?? [], 0, 8),
					'total'      => $this->orderMoney((float)$i['total'] + ($withTax ? (float)$i['tax'] * (int)$i['quantity'] : 0.0), $order),
				], array_slice($items, 0, 50)),
				'items_truncated' => count($items) > 50,
				'totals'          => array_map(fn ($t) => ['code' => (string)$t['code'], 'title' => Text::clean($t['title'], 80), 'amount' => $this->orderMoney((float)$t['value'], $order)], $totals),
				'shipping_method' => $this->methodName($order['shipping_method'] ?? ''),
				'payment_method'  => $this->methodName($order['payment_method'] ?? ''),
				// OpenCart core records no separate payment or delivery state.
				'payment_status'  => 'not_reported_by_store',
				'history'         => array_map(fn ($h) => [
					'date'    => $this->iso($h['date_added']),
					'status'  => $this->status((int)$h['order_status_id'], $h['status_name']),
					// Comments are shown only where the store notified the
					// customer, exactly as the account page does.
					'comment' => (int)$h['notify'] ? Text::clean($h['comment'], 300) : null,
				], $history),
				'view_url'        => $this->platform->extensionLink('order', ['order_id' => $id]),
			],
		];
	}

	/** @return array<string,mixed> */
	public function tracking(array $in): array {
		$order = $this->owned((int)($in['order_id'] ?? 0));
		$entries = [];

		foreach (array_slice($this->platform->trackingFromExtensions([
			'order_id'        => (int)$order['order_id'],
			'store_id'        => $this->ctx->storeId,
			'order_status_id' => (int)$order['order_status_id'],
			'shipping_method' => $this->methodName($order['shipping_method'] ?? ''),
		]), 0, 5) as $entry) {
			if (!is_array($entry)) {
				continue;
			}

			$url = (string)($entry['tracking_url'] ?? '');
			$entries[] = [
				'carrier'         => Text::clean($entry['carrier'] ?? '', 80) ?: null,
				'tracking_number' => Text::clean($entry['tracking_number'] ?? '', 80) ?: null,
				'tracking_url'    => preg_match('#^https?://#i', $url) ? substr($url, 0, 300) : null,
				'status'          => Text::clean($entry['status'] ?? '', 80) ?: null,
				'updated_at'      => Text::clean($entry['updated_at'] ?? '', 30) ?: null,
				'source'          => Text::clean($entry['source'] ?? 'extension', 40),
			];
		}

		return [
			'order_id'  => (string)$order['order_id'],
			'available' => (bool)$entries,
			// No shipment tracking in OpenCart core (`order.tracking` is the
			// AFFILIATE tracking code). Absent a tracking extension, say so.
			'reason'    => $entries ? null : 'no_tracking_source',
			'shipments' => $entries,
			'status'    => $this->status((int)$order['order_status_id'], $order['status_name']),
		];
	}

	/** @return array<string,mixed> */
	public function returns(array $in): array {
		if (empty($this->schema['return_table'])) {
			throw new ApiError('not_supported', 404);
		}

		$page = max(1, min(50, (int)($in['page'] ?? 1)));
		$size = max(1, min(Protocol::MAX_PAGE_SIZE, (int)($in['page_size'] ?? 5)));

		$rows = $this->db->rows('SELECT `r`.`return_id`, `r`.`order_id`, `r`.`product`, `r`.`quantity`, `r`.`date_added`, `rs`.`name` AS `status_name` FROM ' . $this->db->t('return') . ' `r`'
			. ' INNER JOIN ' . $this->db->t('order') . ' `o` ON (`o`.`order_id` = `r`.`order_id` AND ' . $this->scope('o') . ')'
			. ' LEFT JOIN ' . $this->db->t('return_status') . ' `rs` ON (`rs`.`return_status_id` = `r`.`return_status_id` AND `rs`.`language_id` = ' . $this->ctx->languageId . ')'
			. ' WHERE `r`.`customer_id` = ' . $this->customerId . ' ORDER BY `r`.`return_id` DESC LIMIT ' . (($page - 1) * $size) . ',' . ($size + 1));

		return [
			'returns'  => array_map(fn ($r) => [
				'id'         => (string)$r['return_id'],
				'order_id'   => (string)$r['order_id'],
				'product'    => Text::clean($r['product'], 160),
				'quantity'   => (int)$r['quantity'],
				'status'     => Text::clean($r['status_name'] ?? '', 60) ?: null,
				'date_added' => $this->iso($r['date_added']),
			], array_slice($rows, 0, $size)),
			'page'     => $page,
			'has_more' => count($rows) > $size,
		];
	}

	// ── helpers ────────────────────────────────────────────────────────

	private function scope(string $alias): string {
		return '`' . $alias . '`.`customer_id` = ' . $this->customerId . ' AND `' . $alias . '`.`store_id` = ' . $this->ctx->storeId . ' AND `' . $alias . '`.`order_status_id` > 0';
	}

	private function statusNameColumn(string $alias): string {
		return '(SELECT `os`.`name` FROM ' . $this->db->t('order_status') . ' `os` WHERE `os`.`order_status_id` = `' . $alias . '`.`order_status_id` AND `os`.`language_id` = ' . $this->ctx->languageId . ' LIMIT 1) AS `status_name`';
	}

	/** @return array<string,mixed> */
	private function owned(int $orderId): array {
		if ($orderId <= 0) {
			throw new ApiError('order_not_found', 404);
		}

		$row = $this->db->row('SELECT `o`.`order_id`, `o`.`order_status_id`, `o`.`total`, `o`.`currency_code`, `o`.`currency_value`, `o`.`date_added`, `o`.`date_modified`, `o`.`shipping_method`, `o`.`payment_method`, ' . $this->statusNameColumn('o') . ' FROM ' . $this->db->t('order') . ' `o` WHERE `o`.`order_id` = ' . $orderId . ' AND ' . $this->scope('o') . ' LIMIT 1');

		if (!$row) {
			// Same answer for "not yours", "another store" and "does not exist".
			throw new ApiError('order_not_found', 404);
		}

		return $row;
	}

	/** @return array{name:?string,category:string} */
	private function status(int $statusId, $name): array {
		$complete = array_map('intval', (array)($this->platform->config('config_complete_status') ?: []));
		$processing = array_map('intval', (array)($this->platform->config('config_processing_status') ?: []));

		return [
			'name'     => $name !== null ? Text::clean($name, 60) : null,
			'category' => in_array($statusId, $complete, true) ? 'complete' : (in_array($statusId, $processing, true) ? 'processing' : 'other'),
		];
	}

	/** Order money is shown in the order's own currency at the order's own rate, like the account page. */
	private function orderMoney(float $amount, array $order): array {
		$code = (string)$order['currency_code'];
		$rate = (float)$order['currency_value'];
		$places = (int)($this->platform->currencies()[$code]['decimal_place'] ?? 2);

		return [
			'amount'    => number_format($this->platform->convertMoney($amount, $code, $rate), $places, '.', ''),
			'currency'  => $code,
			'formatted' => $this->platform->formatMoney($amount, $code, $rate),
		];
	}

	private function methodName($raw): ?string {
		$raw = (string)$raw;

		if ($raw === '') {
			return null;
		}

		if (!empty($this->schema['order_method_json'])) {
			$decoded = json_decode($raw, true);

			if (is_array($decoded)) {
				return isset($decoded['name']) ? Text::clean($decoded['name'], 120) : null;
			}
		}

		return Text::clean($raw, 120);
	}

	private function iso($value): ?string {
		$value = (string)$value;

		if ($value === '' || strpos($value, '0000-00-00') === 0) {
			return null;
		}

		$ts = strtotime($value);

		return $ts ? date('c', $ts) : null;
	}
}
