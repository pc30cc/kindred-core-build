<?php
require_once DIR_SYSTEM . 'library/webyar/autoload.php';

use WebYar\OpenCart\AdminActions;
use WebYar\OpenCart\Oc3Platform;
use WebYar\OpenCart\Platform;

/**
 * Web Yar — admin side (OpenCart 3.0.5.x). Extensions → Extensions → Modules.
 * Everything but these version hooks lives in core/AdminActions.php.
 */
class ControllerExtensionModuleWebyar extends Controller {
	use AdminActions;

	private const ROUTE = 'extension/module/webyar';
	private const EVENT_CODE = 'webyar_widget';

	protected function wyRoute(): string {
		return self::ROUTE;
	}

	protected function wyMethod(string $method): string {
		return self::ROUTE . '/' . $method;
	}

	protected function wyView(): string {
		return self::ROUTE;
	}

	protected function wyExtensionsRoute(): string {
		return 'marketplace/extension';
	}

	protected function wyModulesRoute(): string {
		return 'extension/extension/module';
	}

	protected function wySupported(): bool {
		return version_compare(VERSION, '3.0.5.0', '>=') && version_compare(VERSION, '3.1.0.0', '<') && PHP_VERSION_ID >= 80100;
	}

	protected function wyAdminLanguageKey(): string {
		return 'config_admin_language';
	}

	protected function wyStoreLanguage(): string {
		return (string)$this->config->get('config_language');
	}

	protected function wyCallbackUrl(string $storeUrl): string {
		return $storeUrl . 'index.php?route=extension/module/webyar/callback';
	}

	protected function wyPlatform(): Platform {
		return new Oc3Platform($this->registry);
	}

	protected function wyAddEvent(): void {
		$this->load->model('setting/event');
		$this->model_setting_event->addEvent(self::EVENT_CODE, 'catalog/view/common/footer/after', self::ROUTE . '/injectWidget', 1, 0);
	}

	protected function wyDeleteEvent(): void {
		$this->load->model('setting/event');
		$this->model_setting_event->deleteEventByCode(self::EVENT_CODE);
	}
}
