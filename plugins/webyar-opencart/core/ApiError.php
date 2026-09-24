<?php
namespace WebYar\OpenCart;

/** A safe, enumerable error: only the code and HTTP status ever leave the store. */
final class ApiError extends \RuntimeException {
	public string $errorCode;
	public int $status;

	public function __construct(string $code, int $status = 400) {
		parent::__construct($code);
		$this->errorCode = $code;
		$this->status = $status;
	}
}
