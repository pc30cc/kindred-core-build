<?php
// Minimal stand-ins for WHMCS runtime classes the addon touches.

namespace WHMCS\Database {
    class Capsule extends \Illuminate\Database\Capsule\Manager
    {
    }
}

namespace WHMCS\Authentication {
    class CurrentUser
    {
        /** @var array{user:?object,client:?object,masquerading:bool} */
        public static $state = array('user' => null, 'client' => null, 'masquerading' => false);

        public function isAuthenticatedUser()
        {
            return self::$state['user'] !== null;
        }

        public function isMasqueradingAdmin()
        {
            return self::$state['masquerading'];
        }

        public function user()
        {
            return self::$state['user'];
        }

        public function client()
        {
            return self::$state['client'];
        }
    }
}
