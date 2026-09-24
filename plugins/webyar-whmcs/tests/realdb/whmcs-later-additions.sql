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
-- The base schema has tbltickets.tid as int(6); WHMCS 8/9 store the public
-- ticket number ("ABC-123456") as text.
ALTER TABLE `tbltickets` MODIFY `tid` varchar(128) COLLATE utf8_unicode_ci NOT NULL DEFAULT '';

-- Public-content columns verified against the isolated installed WHMCS 9.0.1
-- schema. Only the fields the addon selects are needed in this fixture.
ALTER TABLE `tblannouncements` ADD COLUMN IF NOT EXISTS `published` tinyint(1) NOT NULL DEFAULT 1;
ALTER TABLE `tblannouncements` ADD COLUMN IF NOT EXISTS `parentid` int NOT NULL DEFAULT 0;
ALTER TABLE `tblannouncements` ADD COLUMN IF NOT EXISTS `language` text NOT NULL;
ALTER TABLE `tblknowledgebase` ADD COLUMN IF NOT EXISTS `parentid` int NOT NULL DEFAULT 0;
ALTER TABLE `tblknowledgebase` ADD COLUMN IF NOT EXISTS `language` text NOT NULL;
ALTER TABLE `tblknowledgebase` ADD COLUMN IF NOT EXISTS `private` text NOT NULL;
ALTER TABLE `tblknowledgebasecats` ADD COLUMN IF NOT EXISTS `hidden` text NOT NULL;
ALTER TABLE `tblknowledgebasecats` ADD COLUMN IF NOT EXISTS `catid` int NOT NULL DEFAULT 0;
ALTER TABLE `tblknowledgebasecats` ADD COLUMN IF NOT EXISTS `parentid` int NOT NULL DEFAULT 0;
ALTER TABLE `tbladmins` ADD COLUMN IF NOT EXISTS `language` text NOT NULL;
CREATE TABLE IF NOT EXISTS `tblknowledgebaselinks` (
  `id` int NOT NULL AUTO_INCREMENT PRIMARY KEY, `categoryid` int NOT NULL, `articleid` int NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;
CREATE TABLE IF NOT EXISTS `tblnetworkissues` (
  `id` int NOT NULL AUTO_INCREMENT PRIMARY KEY, `title` varchar(150) NOT NULL,
  `description` text NOT NULL, `status` varchar(32) NOT NULL,
  `startdate` datetime NOT NULL, `lastupdate` datetime NOT NULL, `server` int NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;
