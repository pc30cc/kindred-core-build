-- Tables and columns the addon reads that WHMCS adds AFTER its base schema.
--
-- WHMCS ships its base schema as plain SQL (install/sql/install.sql in the
-- official package) and adds everything newer through encoded upgrade
-- scripts that only run inside a licensed install. For a real-database test
-- without a licence, the base schema comes from the official package and the
-- items below are added here, written from the WHMCS developer documentation
-- (Users and Client Accounts, Currencies, product/ticket fields). They are a
-- reconstruction, not a dump of a live WHMCS 9 database.
--
-- Loaded after install.sql; non-strict SQL mode, as WHMCS runs.

CREATE TABLE IF NOT EXISTS `tblcurrencies` (
  `id` int(10) NOT NULL AUTO_INCREMENT,
  `code` text COLLATE utf8_unicode_ci NOT NULL,
  `prefix` text COLLATE utf8_unicode_ci NOT NULL,
  `suffix` text COLLATE utf8_unicode_ci NOT NULL,
  `format` int(1) NOT NULL DEFAULT 1,
  `rate` decimal(10,5) NOT NULL DEFAULT 1.00000,
  `default` int(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE TABLE IF NOT EXISTS `tblusers` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `first_name` varchar(255) COLLATE utf8_unicode_ci NOT NULL DEFAULT '',
  `last_name` varchar(255) COLLATE utf8_unicode_ci NOT NULL DEFAULT '',
  `email` varchar(255) COLLATE utf8_unicode_ci NOT NULL DEFAULT '',
  `password` varchar(255) COLLATE utf8_unicode_ci NOT NULL DEFAULT '',
  `language` varchar(32) COLLATE utf8_unicode_ci NOT NULL DEFAULT '',
  `last_login` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE TABLE IF NOT EXISTS `tblusers_clients` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `auth_user_id` int(10) unsigned NOT NULL,
  `client_id` int(10) unsigned NOT NULL,
  `invite_id` int(10) unsigned NOT NULL DEFAULT 0,
  `owner` tinyint(1) NOT NULL DEFAULT 0,
  `permissions` text COLLATE utf8_unicode_ci,
  `last_login` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `auth_user_id_client_id` (`auth_user_id`, `client_id`),
  KEY `client_id` (`client_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

ALTER TABLE `tblclients` ADD COLUMN IF NOT EXISTS `currency` int(10) NOT NULL DEFAULT 0;
ALTER TABLE `tblhosting` ADD COLUMN IF NOT EXISTS `suspendreason` text COLLATE utf8_unicode_ci NOT NULL;
ALTER TABLE `tblproducts` ADD COLUMN IF NOT EXISTS `retired` tinyint(1) NOT NULL DEFAULT 0;
ALTER TABLE `tblproducts` ADD COLUMN IF NOT EXISTS `order` int(1) NOT NULL DEFAULT 0;
ALTER TABLE `tbldomains` ADD COLUMN IF NOT EXISTS `donotrenew` int(1) NOT NULL DEFAULT 0;
ALTER TABLE `tblinvoices` ADD COLUMN IF NOT EXISTS `invoicenum` text COLLATE utf8_unicode_ci NOT NULL;
ALTER TABLE `tbltickets` ADD COLUMN IF NOT EXISTS `merged_ticket_id` int(10) unsigned NOT NULL DEFAULT 0;
