<?php
namespace Opencart\Admin\Controller\Extension\Webyar\Module;

require_once DIR_EXTENSION . 'webyar/system/library/webyar/autoload.php';

use WebYar\OpenCart\AdminActions;
use WebYar\OpenCart\Oc4Platform;
use WebYar\OpenCart\Platform;

/**
 * Web Yar — admin side (OpenCart 4.1.x). Extensions → Extensions → Modules.
 * Everything but these version hooks lives in core/AdminActions.php.
 */
class Webyar extends \Opencart\System\Engine\Controller {
	use AdminActions;

	private const ROUTE = 'extension/webyar/module/webyar';
	private const EVENT_CODE = 'webyar_widget';

	protected function wyRoute(): string {
		return self::ROUTE;
	}

	protected function wyMethod(string $method): string {
		return self::ROUTE . '.' . $method;
	}

	protected function wyView(): string {
		return self::ROUTE;
	}

	protected function wyExtensionsRoute(): string {
		return 'marketplace/extension';
	}

	protected function wyModulesRoute(): string {
		return 'extension/module';
	}

	protected function wySupported(): bool {
		return version_compare(VERSION, '4.1.0.0', '>=') && version_compare(VERSION, '4.2.0.0', '<') && PHP_VERSION_ID >= 80100;
	}

	protected function wyAdminLanguageKey(): string {
		return 'config_language_admin';
	}

	protected function wyStoreLanguage(): string {
		return (string)$this->config->get('config_language_catalog');
	}

	protected function wyCallbackUrl(string $storeUrl): string {
		return $storeUrl . 'index.php?route=extension/webyar/module/webyar.callback';
	}

	protected function wyPlatform(): Platform {
		return new Oc4Platform($this->registry);
	}

	protected function wyAddEvent(): void {
		$this->load->model('setting/event');
		$this->model_setting_event->addEvent([
			'code'        => self::EVENT_CODE,
			'description' => 'Web Yar: add the chat widget loader to storefront pages',
			'trigger'     => 'catalog/view/common/footer/after',
			'action'      => self::ROUTE . '.injectWidget',
			'status'      => 1,
			'sort_order'  => 0,
		]);
	}

	protected function wyDeleteEvent(): void {
		$this->load->model('setting/event');
		$this->model_setting_event->deleteEventByCode(self::EVENT_CODE);
	}
}
