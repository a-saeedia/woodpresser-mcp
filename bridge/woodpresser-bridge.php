<?php
/**
 * Plugin Name:       Woodpresser Bridge
 * Plugin URI:        https://github.com/woodpresser/woodpresser-mcp
 * Description:       Authenticated execution bridge for the Woodpresser MCP server. Exposes PHP, database, filesystem, snippet and Elementor operations over a locked-down REST namespace.
 * Version:           0.1.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            Woodpresser
 * License:           MIT
 * Text Domain:       woodpresser
 *
 * SECURITY MODEL
 * --------------
 * 1. Every route requires a logged-in user with `manage_options` (Application Password).
 * 2. Every route additionally requires the shared bridge token, sent as `X-Woodpresser-Token`.
 *    The token is either the `WOODPRESSER_TOKEN` constant (wp-config.php, preferred) or the
 *    `woodpresser_token` option, set once through `/claim` by an already-authenticated admin.
 * 3. Requests are rate limited per user.
 * 4. Destructive capabilities are individually switchable through options.
 * 5. Every mutating call is written to an audit table.
 *
 * @package Woodpresser
 */

defined( 'ABSPATH' ) || exit;

define( 'WOODPRESSER_BRIDGE_VERSION', '0.1.0' );
define( 'WOODPRESSER_REST_NS', 'woodpresser/v1' );

/**
 * Main bridge class.
 */
final class Woodpresser_Bridge {

	/** @var string|null Cached token. */
	private static $token = null;

	/** @var array<int,string> Functions blocked in PHP mode unless shell access is enabled. */
	private static $shell_functions = array(
		'exec',
		'shell_exec',
		'system',
		'passthru',
		'proc_open',
		'popen',
		'pcntl_exec',
		'pcntl_fork',
		'pcntl_signal',
	);

	/** @var array<int,string> File extensions the filesystem endpoint may write. */
	private static $writable_ext = array(
		'php',
		'css',
		'scss',
		'js',
		'mjs',
		'json',
		'html',
		'htm',
		'txt',
		'md',
		'svg',
		'po',
		'pot',
		'xml',
	);

	/** @var array<int,string> Paths that may never be written, even inside wp-content. */
	private static $deny_paths = array(
		'.htaccess',
		'.user.ini',
		'php.ini',
		'wp-config.php',
		'index.php',
	);

	/**
	 * Boot.
	 */
	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
		add_action( 'init', array( __CLASS__, 'run_init_snippets' ) );
		add_action( 'admin_init', array( __CLASS__, 'run_admin_snippets' ) );
		add_action( 'wp_head', array( __CLASS__, 'run_head_snippets' ), 99 );
		add_action( 'wp_footer', array( __CLASS__, 'run_footer_snippets' ), 99 );
	}

	/* ---------------------------------------------------------------------
	 * Installation / schema
	 * ------------------------------------------------------------------ */

	/**
	 * Create tables. Called on activation and lazily when the version changes.
	 */
	public static function install() {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset = $wpdb->get_charset_collate();
		$snips   = $wpdb->prefix . 'woodpresser_snippets';
		$audit   = $wpdb->prefix . 'woodpresser_audit';

		dbDelta(
			"CREATE TABLE {$snips} (
				id BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
				name VARCHAR(190) NOT NULL,
				description TEXT NULL,
				code LONGTEXT NOT NULL,
				scope VARCHAR(32) NOT NULL DEFAULT 'manual',
				active TINYINT(1) NOT NULL DEFAULT 0,
				priority INT(11) NOT NULL DEFAULT 10,
				created_at DATETIME NOT NULL,
				updated_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				KEY active_scope (active, scope, priority)
			) {$charset};"
		);

		dbDelta(
			"CREATE TABLE {$audit} (
				id BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
				created_at DATETIME NOT NULL,
				user_id BIGINT(20) UNSIGNED NOT NULL DEFAULT 0,
				action VARCHAR(64) NOT NULL,
				target VARCHAR(255) NULL,
				meta LONGTEXT NULL,
				PRIMARY KEY  (id),
				KEY created_at (created_at)
			) {$charset};"
		);

		update_option( 'woodpresser_bridge_version', WOODPRESSER_BRIDGE_VERSION, false );
	}

	/**
	 * Lazily install when the plugin files were updated without activation.
	 */
	private static function maybe_install() {
		if ( get_option( 'woodpresser_bridge_version' ) !== WOODPRESSER_BRIDGE_VERSION ) {
			self::install();
		}
	}

	/* ---------------------------------------------------------------------
	 * Auth
	 * ------------------------------------------------------------------ */

	/**
	 * Resolve the configured token.
	 *
	 * @return string
	 */
	private static function token() {
		if ( null !== self::$token ) {
			return self::$token;
		}
		if ( defined( 'WOODPRESSER_TOKEN' ) && WOODPRESSER_TOKEN ) {
			self::$token = (string) WOODPRESSER_TOKEN;
		} else {
			self::$token = (string) get_option( 'woodpresser_token', '' );
		}
		return self::$token;
	}

	/**
	 * Read the presented token.
	 *
	 * @return string
	 */
	private static function presented_token() {
		$header = isset( $_SERVER['HTTP_X_WOODPRESSER_TOKEN'] )
			? sanitize_text_field( wp_unslash( $_SERVER['HTTP_X_WOODPRESSER_TOKEN'] ) )
			: '';
		return (string) $header;
	}

	/**
	 * Capability + rate limit check.
	 *
	 * @return true|WP_Error
	 */
	public static function require_admin() {
		if ( ! is_user_logged_in() || ! current_user_can( 'manage_options' ) ) {
			return new WP_Error(
				'woodpresser_forbidden',
				'Application Password authentication with an administrator account is required.',
				array( 'status' => 401 )
			);
		}

		$user_id = get_current_user_id();
		$key     = 'woodpresser_rl_' . $user_id;
		$bucket  = get_transient( $key );
		$bucket  = is_array( $bucket ) ? $bucket : array(
			'count' => 0,
			'start' => time(),
		);

		if ( time() - (int) $bucket['start'] > 60 ) {
			$bucket = array(
				'count' => 0,
				'start' => time(),
			);
		}
		++$bucket['count'];
		set_transient( $key, $bucket, 120 );

		if ( $bucket['count'] > 240 ) {
			return new WP_Error(
				'woodpresser_rate_limited',
				'Rate limit exceeded (240 requests/minute). Slow down.',
				array( 'status' => 429 )
			);
		}

		return true;
	}

	/**
	 * Full authorization: admin + token.
	 *
	 * @return true|WP_Error
	 */
	public static function authorize() {
		$admin = self::require_admin();
		if ( is_wp_error( $admin ) ) {
			return $admin;
		}

		self::maybe_install();

		$stored = self::token();
		if ( '' === $stored ) {
			return new WP_Error(
				'woodpresser_not_claimed',
				'Bridge is not claimed yet. POST /wp-json/woodpresser/v1/claim with a token first.',
				array( 'status' => 428 )
			);
		}

		if ( ! hash_equals( $stored, self::presented_token() ) ) {
			return new WP_Error(
				'woodpresser_bad_token',
				'Missing or invalid X-Woodpresser-Token header.',
				array( 'status' => 403 )
			);
		}

		return true;
	}

	/**
	 * Settings used to gate dangerous features.
	 *
	 * @return array<string,bool>
	 */
	private static function flags() {
		$defaults = array(
			'allow_php'       => true,
			'allow_shell'     => false,
			'allow_db_write'  => false,
			'allow_file_write'=> true,
			'allow_plugins'   => true,
		);
		$saved = get_option( 'woodpresser_flags', array() );
		$saved = is_array( $saved ) ? $saved : array();
		return array_merge( $defaults, array_map( 'boolval', $saved ) );
	}

	/* ---------------------------------------------------------------------
	 * Routes
	 * ------------------------------------------------------------------ */

	/**
	 * Register all routes.
	 */
	public static function register_routes() {
		$public = array( __CLASS__, 'route_ping' );

		register_rest_route(
			WOODPRESSER_REST_NS,
			'/ping',
			array(
				'methods'             => 'GET',
				'callback'            => $public,
				'permission_callback' => array( __CLASS__, 'require_admin' ),
			)
		);

		register_rest_route(
			WOODPRESSER_REST_NS,
			'/claim',
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'route_claim' ),
				'permission_callback' => array( __CLASS__, 'require_admin' ),
				'args'                => array(
					'token' => array( 'required' => true ),
				),
			)
		);

		$routes = array(
			'/php'       => array( 'POST', 'route_php' ),
			'/db'        => array( 'POST', 'route_db' ),
			'/fs'        => array( 'POST', 'route_fs' ),
			'/snippets'  => array( 'GET', 'route_snippets_list' ),
			'/snippets/save'   => array( 'POST', 'route_snippets_save' ),
			'/snippets/delete' => array( 'POST', 'route_snippets_delete' ),
			'/snippets/run'    => array( 'POST', 'route_snippets_run' ),
			'/elementor'       => array( 'POST', 'route_elementor' ),
			'/audit'           => array( 'GET', 'route_audit' ),
			'/flags'           => array( 'POST', 'route_flags' ),
		);

		foreach ( $routes as $path => $spec ) {
			register_rest_route(
				WOODPRESSER_REST_NS,
				$path,
				array(
					'methods'             => $spec[0],
					'callback'            => array( __CLASS__, $spec[1] ),
					'permission_callback' => array( __CLASS__, 'authorize' ),
				)
			);
		}
	}

	/**
	 * Summarize the environment.
	 *
	 * @return WP_REST_Response
	 */
	public static function route_ping() {
		global $wpdb;

		$theme = wp_get_theme();
		$flags = self::flags();

		return self::ok(
			array(
				'ok'              => true,
				'plugin_version'  => WOODPRESSER_BRIDGE_VERSION,
				'claimed'         => '' !== self::token(),
				'token_source'    => defined( 'WOODPRESSER_TOKEN' ) ? 'constant' : 'option',
				'wp_version'      => get_bloginfo( 'version' ),
				'php_version'     => PHP_VERSION,
				'site_url'        => home_url(),
				'is_multisite'    => is_multisite(),
				'theme'           => array(
					'name'    => $theme->get( 'Name' ),
					'version' => $theme->get( 'Version' ),
					'stylesheet' => get_stylesheet(),
				),
				'db_prefix'       => $wpdb->prefix,
				'elementor'       => defined( 'ELEMENTOR_VERSION' ) ? ELEMENTOR_VERSION : null,
				'elementor_pro'   => defined( 'ELEMENTOR_PRO_VERSION' ) ? ELEMENTOR_PRO_VERSION : null,
				'wpcode'          => defined( 'WPCODE_VERSION' ) ? WPCODE_VERSION : null,
				'woocommerce'     => defined( 'WC_VERSION' ) ? WC_VERSION : null,
				'users_can_register' => (bool) get_option( 'users_can_register' ),
				'flags'           => $flags,
				'limits'          => array(
					'max_php_bytes' => 512000,
					'max_fs_bytes'  => 2097152,
				),
			)
		);
	}

	/**
	 * Bind the bridge token on first use.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function route_claim( WP_REST_Request $request ) {
		if ( defined( 'WOODPRESSER_TOKEN' ) && WOODPRESSER_TOKEN ) {
			return new WP_Error(
				'woodpresser_token_locked',
				'WOODPRESSER_TOKEN is defined in wp-config.php. The bridge cannot be re-claimed over HTTP.',
				array( 'status' => 409 )
			);
		}

		$token = trim( (string) $request->get_param( 'token' ) );
		if ( strlen( $token ) < 32 || ! preg_match( '/^[A-Za-z0-9_\-\/+=]+$/', $token ) ) {
			return new WP_Error(
				'woodpresser_weak_token',
				'Token must be at least 32 characters of [A-Za-z0-9_-/+=].',
				array( 'status' => 400 )
			);
		}

		$existing = (string) get_option( 'woodpresser_token', '' );
		if ( '' !== $existing ) {
			$presented = self::presented_token();
			if ( ! hash_equals( $existing, $presented ) ) {
				return new WP_Error(
					'woodpresser_already_claimed',
					'Bridge is already claimed. Present the current X-Woodpresser-Token to rotate it.',
					array( 'status' => 403 )
				);
			}
		}

		update_option( 'woodpresser_token', $token, false );
		self::$token = $token;
		self::audit( 'claim', 'bridge', array( 'rotated' => '' !== $existing ) );

		return self::ok(
			array(
				'ok'      => true,
				'claimed' => true,
				'rotated' => '' !== $existing,
			)
		);
	}

	/**
	 * Execute PHP.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function route_php( WP_REST_Request $request ) {
		$flags = self::flags();
		if ( empty( $flags['allow_php'] ) ) {
			return new WP_Error( 'woodpresser_php_disabled', 'PHP execution is disabled on this site.', array( 'status' => 403 ) );
		}

		$code = (string) $request->get_param( 'code' );
		$mode = (string) ( $request->get_param( 'mode' ) ?: 'php' );

		return self::ok( self::execute_php( $code, $mode, $flags ) );
	}

	/**
	 * Run SQL.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function route_db( WP_REST_Request $request ) {
		global $wpdb;

		$sql     = trim( (string) $request->get_param( 'sql' ) );
		$params  = $request->get_param( 'params' );
		$params  = is_array( $params ) ? array_values( $params ) : array();
		$flags   = self::flags();
		$keyword = strtoupper( (string) preg_replace( '/^\s*(?:\/\*.*?\*\/\s*)*/', '', $sql ) );
		$keyword = strtok( $keyword, " \t\n\r(" );
		$read    = in_array( $keyword, array( 'SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH' ), true );

		if ( '' === $sql ) {
			return new WP_Error( 'woodpresser_empty_sql', 'sql is required.', array( 'status' => 400 ) );
		}
		if ( self::has_multiple_statements( $sql ) ) {
			return new WP_Error( 'woodpresser_multi_statement', 'Only one statement per request.', array( 'status' => 400 ) );
		}
		if ( ! $read && empty( $flags['allow_db_write'] ) ) {
			return new WP_Error(
				'woodpresser_db_readonly',
				'This bridge is read-only. Enable allow_db_write in the bridge flags first.',
				array( 'status' => 403 )
			);
		}
		if ( preg_match( '/\b(DROP\s+DATABASE|GRANT|CREATE\s+USER|INTO\s+OUTFILE|LOAD_FILE)\b/i', $sql ) ) {
			return new WP_Error( 'woodpresser_db_blocked', 'Statement blocked by policy.', array( 'status' => 403 ) );
		}

		$start = microtime( true );

		if ( $params ) {
			// phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
			$sql = $wpdb->prepare( $sql, $params );
		}

		$wpdb->last_error = '';
		if ( $read ) {
			// phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared, WordPress.DB.DirectDatabaseQuery
			$rows = $wpdb->get_results( $sql, ARRAY_A );
		} else {
			// phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared, WordPress.DB.DirectDatabaseQuery
			$rows = $wpdb->query( $sql );
		}

		if ( $wpdb->last_error ) {
			return self::ok(
				array(
					'ok'    => false,
					'error' => $wpdb->last_error,
					'sql'   => $sql,
				)
			);
		}

		self::audit( 'db', $keyword, array( 'sql' => self::truncate( $sql, 500 ) ) );

		return self::ok(
			array(
				'ok'         => true,
				'statement'  => $keyword,
				'read_only'  => $read,
				'rows'       => $read ? array_slice( is_array( $rows ) ? $rows : array(), 0, 500 ) : $rows,
				'row_count'  => $read ? count( is_array( $rows ) ? $rows : array() ) : (int) $rows,
				'insert_id'  => (int) $wpdb->insert_id,
				'duration_ms'=> round( ( microtime( true ) - $start ) * 1000, 1 ),
			)
		);
	}

	/**
	 * Filesystem operations, jailed to WP_CONTENT_DIR.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function route_fs( WP_REST_Request $request ) {
		$flags = self::flags();
		$op    = (string) $request->get_param( 'op' );
		$path  = (string) $request->get_param( 'path' );
		$root  = realpath( WP_CONTENT_DIR );

		if ( ! $root ) {
			return new WP_Error( 'woodpresser_fs_root', 'wp-content is not readable.', array( 'status' => 500 ) );
		}

		$resolved = self::resolve_path( $root, $path );
		if ( is_wp_error( $resolved ) ) {
			return $resolved;
		}

		$is_write = in_array( $op, array( 'write', 'append', 'delete', 'mkdir' ), true );
		if ( $is_write && empty( $flags['allow_file_write'] ) ) {
			return new WP_Error( 'woodpresser_fs_readonly', 'Filesystem writes are disabled on this site.', array( 'status' => 403 ) );
		}

		switch ( $op ) {
			case 'list':
				if ( ! is_dir( $resolved ) ) {
					return new WP_Error( 'woodpresser_not_dir', 'Not a directory.', array( 'status' => 400 ) );
				}
				$entries = array();
				foreach ( scandir( $resolved ) as $entry ) {
					if ( '.' === $entry || '..' === $entry ) {
						continue;
					}
					$full      = $resolved . DIRECTORY_SEPARATOR . $entry;
					$entries[] = array(
						'name'  => $entry,
						'type'  => is_dir( $full ) ? 'dir' : 'file',
						'size'  => is_file( $full ) ? filesize( $full ) : null,
						'mtime' => date( 'c', filemtime( $full ) ),
					);
				}
				usort(
					$entries,
					static function ( $a, $b ) {
						return strcmp( $a['name'], $b['name'] );
					}
				);
				self::audit( 'fs_list', $path );
				return self::ok( array( 'ok' => true, 'path' => $path, 'entries' => $entries ) );

			case 'read':
				if ( ! is_file( $resolved ) ) {
					return new WP_Error( 'woodpresser_not_file', 'Not a file.', array( 'status' => 404 ) );
				}
				$size = filesize( $resolved );
				if ( $size > 2097152 ) {
					return new WP_Error( 'woodpresser_too_large', 'File is larger than 2 MB.', array( 'status' => 413 ) );
				}
				self::audit( 'fs_read', $path );
				return self::ok(
					array(
						'ok'        => true,
						'path'      => $path,
						'size'      => $size,
						'content'   => (string) file_get_contents( $resolved ),
						'is_php'    => 'php' === strtolower( pathinfo( $resolved, PATHINFO_EXTENSION ) ),
					)
				);

			case 'stat':
				return self::ok(
					array(
						'ok'   => true,
						'path' => $path,
						'exists' => file_exists( $resolved ),
						'type' => is_dir( $resolved ) ? 'dir' : ( is_file( $resolved ) ? 'file' : 'missing' ),
						'size' => is_file( $resolved ) ? filesize( $resolved ) : null,
						'mtime'=> file_exists( $resolved ) ? date( 'c', filemtime( $resolved ) ) : null,
					)
				);

			case 'write':
			case 'append':
				$content = (string) $request->get_param( 'content' );
				if ( strlen( $content ) > 2097152 ) {
					return new WP_Error( 'woodpresser_too_large', 'Payload is larger than 2 MB.', array( 'status' => 413 ) );
				}
				$ext = strtolower( pathinfo( $resolved, PATHINFO_EXTENSION ) );
				if ( ! in_array( $ext, self::$writable_ext, true ) ) {
					return new WP_Error( 'woodpresser_ext_blocked', 'Extension .' . $ext . ' is not writable through the bridge.', array( 'status' => 403 ) );
				}
				foreach ( self::$deny_paths as $deny ) {
					if ( basename( $resolved ) === $deny ) {
						return new WP_Error( 'woodpresser_path_blocked', 'That filename is protected.', array( 'status' => 403 ) );
					}
				}
				$dir = dirname( $resolved );
				if ( ! is_dir( $dir ) && ! wp_mkdir_p( $dir ) ) {
					return new WP_Error( 'woodpresser_no_parent', 'Parent directory does not exist and could not be created.', array( 'status' => 400 ) );
				}
				$backup = null;
				if ( is_file( $resolved ) && 'write' === $op ) {
					$backup = self::backup_file( $resolved );
				}
				$bytes = 'append' === $op
					? file_put_contents( $resolved, $content, FILE_APPEND | LOCK_EX )
					: file_put_contents( $resolved, $content, LOCK_EX );
				if ( false === $bytes ) {
					return new WP_Error( 'woodpresser_write_failed', 'Could not write the file.', array( 'status' => 500 ) );
				}
				if ( 'php' === $ext && function_exists( 'opcache_invalidate' ) ) {
					@opcache_invalidate( $resolved, true );
				}
				self::audit( 'fs_' . $op, $path, array( 'bytes' => $bytes, 'backup' => $backup ) );
				return self::ok( array( 'ok' => true, 'path' => $path, 'bytes' => $bytes, 'backup' => $backup ) );

			case 'mkdir':
				if ( is_dir( $resolved ) ) {
					return self::ok( array( 'ok' => true, 'path' => $path, 'created' => false ) );
				}
				if ( ! wp_mkdir_p( $resolved ) ) {
					return new WP_Error( 'woodpresser_mkdir_failed', 'Could not create directory.', array( 'status' => 500 ) );
				}
				self::audit( 'fs_mkdir', $path );
				return self::ok( array( 'ok' => true, 'path' => $path, 'created' => true ) );

			case 'delete':
				if ( ! file_exists( $resolved ) ) {
					return self::ok( array( 'ok' => true, 'path' => $path, 'deleted' => false ) );
				}
				$backup = is_file( $resolved ) ? self::backup_file( $resolved ) : null;
				if ( is_dir( $resolved ) ) {
					return new WP_Error( 'woodpresser_is_dir', 'Refusing to delete directories. Delete files individually.', array( 'status' => 400 ) );
				}
				$ok = unlink( $resolved );
				self::audit( 'fs_delete', $path, array( 'backup' => $backup ) );
				return self::ok( array( 'ok' => (bool) $ok, 'path' => $path, 'deleted' => (bool) $ok, 'backup' => $backup ) );
		}

		return new WP_Error( 'woodpresser_bad_op', 'Unknown op. Use list|read|stat|write|append|mkdir|delete.', array( 'status' => 400 ) );
	}

	/* ---------------------------------------------------------------------
	 * Snippets
	 * ------------------------------------------------------------------ */

	/**
	 * List snippets.
	 *
	 * @return WP_REST_Response
	 */
	public static function route_snippets_list() {
		global $wpdb;
		$table = $wpdb->prefix . 'woodpresser_snippets';
		// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery
		$rows = $wpdb->get_results( "SELECT id, name, description, scope, active, priority, LENGTH(code) AS code_bytes, created_at, updated_at FROM {$table} ORDER BY id ASC", ARRAY_A );
		return self::ok( array( 'ok' => true, 'snippets' => $rows ? $rows : array() ) );
	}

	/**
	 * Create or update a snippet.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function route_snippets_save( WP_REST_Request $request ) {
		global $wpdb;

		$flags = self::flags();
		if ( empty( $flags['allow_php'] ) ) {
			return new WP_Error( 'woodpresser_php_disabled', 'PHP execution is disabled on this site.', array( 'status' => 403 ) );
		}

		$table = $wpdb->prefix . 'woodpresser_snippets';
		$id    = (int) $request->get_param( 'id' );
		$name  = sanitize_text_field( (string) $request->get_param( 'name' ) );
		$code  = (string) $request->get_param( 'code' );
		$scope = (string) ( $request->get_param( 'scope' ) ?: 'manual' );
		$desc  = (string) ( $request->get_param( 'description' ) ?: '' );
		$prio  = (int) ( $request->get_param( 'priority' ) ?: 10 );
		$active = $request->get_param( 'active' );
		$active = null === $active ? 0 : (int) (bool) $active;

		if ( '' === $name || '' === $code ) {
			return new WP_Error( 'woodpresser_snippet_invalid', 'name and code are required.', array( 'status' => 400 ) );
		}
		if ( ! in_array( $scope, array( 'init', 'admin_init', 'wp_head', 'wp_footer', 'manual' ), true ) ) {
			return new WP_Error( 'woodpresser_snippet_scope', 'scope must be init|admin_init|wp_head|wp_footer|manual.', array( 'status' => 400 ) );
		}

		$now = current_time( 'mysql' );

		if ( $id > 0 ) {
			// phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$wpdb->update(
				$table,
				array(
					'name'        => $name,
					'description' => $desc,
					'code'        => $code,
					'scope'       => $scope,
					'active'      => $active,
					'priority'    => $prio,
					'updated_at'  => $now,
				),
				array( 'id' => $id ),
				array( '%s', '%s', '%s', '%s', '%d', '%d', '%s' ),
				array( '%d' )
			);
			self::audit( 'snippet_update', (string) $id, array( 'scope' => $scope, 'active' => $active ) );
			return self::ok( array( 'ok' => true, 'id' => $id, 'updated' => true ) );
		}

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$wpdb->insert(
			$table,
			array(
				'name'        => $name,
				'description' => $desc,
				'code'        => $code,
				'scope'       => $scope,
				'active'      => $active,
				'priority'    => $prio,
				'created_at'  => $now,
				'updated_at'  => $now,
			),
			array( '%s', '%s', '%s', '%s', '%d', '%d', '%s', '%s' )
		);

		$new_id = (int) $wpdb->insert_id;
		self::audit( 'snippet_create', (string) $new_id, array( 'name' => $name, 'scope' => $scope ) );
		return self::ok( array( 'ok' => true, 'id' => $new_id, 'updated' => false ) );
	}

	/**
	 * Delete a snippet.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function route_snippets_delete( WP_REST_Request $request ) {
		global $wpdb;
		$table = $wpdb->prefix . 'woodpresser_snippets';
		$id    = (int) $request->get_param( 'id' );
		if ( $id <= 0 ) {
			return new WP_Error( 'woodpresser_snippet_invalid', 'id is required.', array( 'status' => 400 ) );
		}
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$wpdb->delete( $table, array( 'id' => $id ), array( '%d' ) );
		self::audit( 'snippet_delete', (string) $id );
		return self::ok( array( 'ok' => true, 'id' => $id, 'deleted' => true ) );
	}

	/**
	 * Execute a snippet on demand, regardless of active state.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function route_snippets_run( WP_REST_Request $request ) {
		global $wpdb;
		$table = $wpdb->prefix . 'woodpresser_snippets';
		$id    = (int) $request->get_param( 'id' );
		// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT id, name, code, scope FROM {$table} WHERE id = %d", $id ), ARRAY_A );
		if ( ! $row ) {
			return new WP_Error( 'woodpresser_snippet_missing', 'Snippet not found.', array( 'status' => 404 ) );
		}
		$result = self::execute_php( $row['code'], 'php', self::flags() );
		self::audit( 'snippet_run', (string) $id, array( 'ok' => $result['ok'] ) );
		return self::ok( array_merge( $result, array( 'snippet' => (int) $row['id'], 'name' => $row['name'] ) ) );
	}

	/**
	 * Run snippets bound to a hook.
	 *
	 * @param string $scope Scope name.
	 */
	private static function run_scope( $scope ) {
		global $wpdb;
		$table = $wpdb->prefix . 'woodpresser_snippets';
		// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery
		$rows = $wpdb->get_results( $wpdb->prepare( "SELECT id, code FROM {$table} WHERE active = 1 AND scope = %s ORDER BY priority ASC, id ASC", $scope ), ARRAY_A );
		if ( ! $rows ) {
			return;
		}
		foreach ( $rows as $row ) {
			self::execute_php( $row['code'], 'php', self::flags(), false );
		}
	}

	/** Run init snippets. */
	public static function run_init_snippets() {
		self::run_scope( 'init' );
	}

	/** Run admin_init snippets. */
	public static function run_admin_snippets() {
		self::run_scope( 'admin_init' );
	}

	/** Run wp_head snippets. */
	public static function run_head_snippets() {
		self::run_scope( 'wp_head' );
	}

	/** Run wp_footer snippets. */
	public static function run_footer_snippets() {
		self::run_scope( 'wp_footer' );
	}

	/* ---------------------------------------------------------------------
	 * Elementor
	 * ------------------------------------------------------------------ */

	/**
	 * Elementor operations.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function route_elementor( WP_REST_Request $request ) {
		$action  = (string) $request->get_param( 'action' );
		$post_id = (int) $request->get_param( 'post_id' );

		switch ( $action ) {
			case 'status':
				$active = did_action( 'elementor/loaded' ) || class_exists( '\Elementor\Plugin' );
				return self::ok(
					array(
						'ok'         => true,
						'active'     => $active,
						'version'    => defined( 'ELEMENTOR_VERSION' ) ? ELEMENTOR_VERSION : null,
						'pro'        => defined( 'ELEMENTOR_PRO_VERSION' ) ? ELEMENTOR_PRO_VERSION : null,
						'containers' => $active && class_exists( '\Elementor\Plugin' )
							? (bool) \Elementor\Plugin::$instance->experiments->is_feature_active( 'container' )
							: null,
					)
				);

			case 'widgets':
				if ( ! class_exists( '\Elementor\Plugin' ) ) {
					return new WP_Error( 'woodpresser_no_elementor', 'Elementor is not active.', array( 'status' => 409 ) );
				}
				$out = array();
				foreach ( \Elementor\Plugin::$instance->widgets_manager->get_widget_types() as $name => $widget ) {
					$out[] = array(
						'widgetType' => $name,
						'title'      => $widget->get_title(),
						'categories' => array_values( (array) $widget->get_categories() ),
						'is_pro'     => (bool) $widget->is_pro(),
					);
				}
				usort(
					$out,
					static function ( $a, $b ) {
						return strcmp( $a['widgetType'], $b['widgetType'] );
					}
				);
				return self::ok( array( 'ok' => true, 'widgets' => $out ) );

			case 'get':
				return self::elementor_get( $post_id );

			case 'set':
				$data = $request->get_param( 'data' );
				$snap = $request->get_param( 'snapshot' );
				return self::elementor_set( $post_id, $data, null === $snap ? true : (bool) $snap );

			case 'snapshots':
				return self::ok( array( 'ok' => true, 'snapshots' => self::snapshot_list( $post_id ) ) );

			case 'restore':
				$index = (int) $request->get_param( 'index' );
				return self::elementor_restore( $post_id, $index );

			case 'clear_cache':
				if ( class_exists( '\Elementor\Plugin' ) ) {
					\Elementor\Plugin::$instance->files_manager->clear_cache();
				}
				if ( function_exists( 'wp_cache_flush' ) ) {
					wp_cache_flush();
				}
				self::audit( 'elementor_clear_cache', '' );
				return self::ok( array( 'ok' => true, 'cleared' => true ) );
		}

		return new WP_Error( 'woodpresser_bad_action', 'Unknown action. Use status|widgets|get|set|snapshots|restore|clear_cache.', array( 'status' => 400 ) );
	}

	/**
	 * Read Elementor data for a post.
	 *
	 * @param int $post_id Post ID.
	 * @return WP_REST_Response|WP_Error
	 */
	private static function elementor_get( $post_id ) {
		$post = get_post( $post_id );
		if ( ! $post ) {
			return new WP_Error( 'woodpresser_no_post', 'Post not found.', array( 'status' => 404 ) );
		}

		$raw  = get_post_meta( $post_id, '_elementor_data', true );
		$data = null;
		if ( is_string( $raw ) && '' !== $raw ) {
			$data = json_decode( $raw, true );
		} elseif ( is_array( $raw ) ) {
			$data = $raw;
		}

		return self::ok(
			array(
				'ok'            => true,
				'post_id'       => $post_id,
				'post_type'     => $post->post_type,
				'title'         => get_the_title( $post_id ),
				'status'        => $post->post_status,
				'link'          => get_permalink( $post_id ),
				'edit_mode'     => get_post_meta( $post_id, '_elementor_edit_mode', true ),
				'template_type' => get_post_meta( $post_id, '_elementor_template_type', true ),
				'el_version'    => get_post_meta( $post_id, '_elementor_version', true ),
				'page_template' => get_post_meta( $post_id, '_wp_page_template', true ),
				'page_settings' => json_decode( (string) get_post_meta( $post_id, '_elementor_page_settings', true ), true ),
				'data'          => $data,
				'elements'      => is_array( $data ) ? count( $data ) : 0,
			)
		);
	}

	/**
	 * Write Elementor data, snapshotting the previous state.
	 *
	 * @param int        $post_id  Post ID.
	 * @param mixed      $data     Array or JSON string.
	 * @param bool       $snapshot Whether to snapshot.
	 * @return WP_REST_Response|WP_Error
	 */
	private static function elementor_set( $post_id, $data, $snapshot = true ) {
		$post = get_post( $post_id );
		if ( ! $post ) {
			return new WP_Error( 'woodpresser_no_post', 'Post not found.', array( 'status' => 404 ) );
		}

		if ( is_string( $data ) ) {
			$decoded = json_decode( $data, true );
			if ( null === $decoded && 'null' !== trim( $data ) ) {
				return new WP_Error( 'woodpresser_bad_json', 'data is not valid JSON.', array( 'status' => 400 ) );
			}
			$data = $decoded;
		}

		if ( ! is_array( $data ) ) {
			return new WP_Error( 'woodpresser_bad_data', 'data must be an array of Elementor elements.', array( 'status' => 400 ) );
		}

		$previous = get_post_meta( $post_id, '_elementor_data', true );
		if ( $snapshot && $previous ) {
			self::snapshot_push( $post_id, $previous );
		}

		$json = wp_json_encode( $data );
		if ( false === $json ) {
			return new WP_Error( 'woodpresser_encode_failed', 'Could not encode Elementor data.', array( 'status' => 400 ) );
		}

		update_post_meta( $post_id, '_elementor_data', wp_slash( $json ) );
		update_post_meta( $post_id, '_elementor_edit_mode', 'builder' );
		if ( defined( 'ELEMENTOR_VERSION' ) ) {
			update_post_meta( $post_id, '_elementor_version', ELEMENTOR_VERSION );
		}

		if ( class_exists( '\Elementor\Plugin' ) ) {
			\Elementor\Plugin::$instance->files_manager->clear_cache();
		}

		self::audit( 'elementor_set', (string) $post_id, array( 'bytes' => strlen( $json ) ) );

		return self::ok(
			array(
				'ok'       => true,
				'post_id'  => $post_id,
				'bytes'    => strlen( $json ),
				'elements' => count( $data ),
				'preview'  => get_permalink( $post_id ),
			)
		);
	}

	/**
	 * Snapshot keys are per post, capped at five entries.
	 *
	 * @param int    $post_id  Post.
	 * @param string $payload  Raw JSON.
	 */
	private static function snapshot_push( $post_id, $payload ) {
		$key  = 'woodpresser_el_snap_' . $post_id;
		$list = get_option( $key, array() );
		$list = is_array( $list ) ? $list : array();
		array_unshift(
			$list,
			array(
				'at'      => current_time( 'mysql' ),
				'user_id' => get_current_user_id(),
				'bytes'   => strlen( (string) $payload ),
				'payload' => (string) $payload,
			)
		);
		$list = array_slice( $list, 0, 5 );
		update_option( $key, $list, false );
	}

	/**
	 * List snapshots without payloads.
	 *
	 * @param int $post_id Post.
	 * @return array<int,array<string,mixed>>
	 */
	private static function snapshot_list( $post_id ) {
		$list = get_option( 'woodpresser_el_snap_' . $post_id, array() );
		$list = is_array( $list ) ? $list : array();
		$out  = array();
		foreach ( $list as $i => $snap ) {
			$out[] = array(
				'index'   => $i,
				'at'      => $snap['at'] ?? null,
				'bytes'   => $snap['bytes'] ?? null,
				'user_id' => $snap['user_id'] ?? null,
			);
		}
		return $out;
	}

	/**
	 * Restore a snapshot by index.
	 *
	 * @param int $post_id Post.
	 * @param int $index   Index.
	 * @return WP_REST_Response|WP_Error
	 */
	private static function elementor_restore( $post_id, $index ) {
		$list = get_option( 'woodpresser_el_snap_' . $post_id, array() );
		if ( ! is_array( $list ) || ! isset( $list[ $index ]['payload'] ) ) {
			return new WP_Error( 'woodpresser_no_snapshot', 'Snapshot index not found.', array( 'status' => 404 ) );
		}
		$current = get_post_meta( $post_id, '_elementor_data', true );
		if ( $current ) {
			self::snapshot_push( $post_id, $current );
		}
		update_post_meta( $post_id, '_elementor_data', wp_slash( $list[ $index ]['payload'] ) );
		update_post_meta( $post_id, '_elementor_edit_mode', 'builder' );
		if ( class_exists( '\Elementor\Plugin' ) ) {
			\Elementor\Plugin::$instance->files_manager->clear_cache();
		}
		self::audit( 'elementor_restore', (string) $post_id, array( 'index' => $index ) );
		return self::ok( array( 'ok' => true, 'post_id' => $post_id, 'restored_index' => $index ) );
	}

	/* ---------------------------------------------------------------------
	 * Flags + audit
	 * ------------------------------------------------------------------ */

	/**
	 * Update bridge flags.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response
	 */
	public static function route_flags( WP_REST_Request $request ) {
		$allowed = array( 'allow_php', 'allow_shell', 'allow_db_write', 'allow_file_write', 'allow_plugins' );
		$current = self::flags();
		$next    = $current;
		$changed = array();

		foreach ( $allowed as $flag ) {
			$value = $request->get_param( $flag );
			if ( null !== $value ) {
				$next[ $flag ]   = (bool) $value;
				$changed[ $flag ] = (bool) $value;
			}
		}

		update_option( 'woodpresser_flags', $next, false );
		self::audit( 'flags', '', $changed );

		return self::ok( array( 'ok' => true, 'flags' => $next, 'changed' => $changed ) );
	}

	/**
	 * Recent audit rows.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response
	 */
	public static function route_audit( WP_REST_Request $request ) {
		global $wpdb;
		$limit = max( 1, min( 500, (int) ( $request->get_param( 'limit' ) ?: 50 ) ) );
		$table = $wpdb->prefix . 'woodpresser_audit';
		// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery
		$rows = $wpdb->get_results( $wpdb->prepare( "SELECT id, created_at, user_id, action, target, meta FROM {$table} ORDER BY id DESC LIMIT %d", $limit ), ARRAY_A );
		return self::ok( array( 'ok' => true, 'entries' => $rows ? $rows : array() ) );
	}

	/**
	 * Write an audit row.
	 *
	 * @param string $action Action.
	 * @param string $target Target.
	 * @param array  $meta   Metadata.
	 */
	private static function audit( $action, $target = '', $meta = array() ) {
		global $wpdb;
		if ( ! $wpdb || ! $wpdb->prefix ) {
			return;
		}
		$table = $wpdb->prefix . 'woodpresser_audit';
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$wpdb->insert(
			$table,
			array(
				'created_at' => current_time( 'mysql' ),
				'user_id'    => get_current_user_id(),
				'action'     => substr( (string) $action, 0, 64 ),
				'target'     => substr( (string) $target, 0, 255 ),
				'meta'       => wp_json_encode( $meta ),
			),
			array( '%s', '%d', '%s', '%s', '%s' )
		);
	}

	/* ---------------------------------------------------------------------
	 * Helpers
	 * ------------------------------------------------------------------ */

	/**
	 * Execute a PHP string with output + fatal capture.
	 *
	 * @param string $code     Code.
	 * @param string $mode     php|template.
	 * @param array  $flags    Bridge flags.
	 * @param bool   $isolated Whether to emit an error payload on failure.
	 * @return array<string,mixed>
	 */
	private static function execute_php( $code, $mode, $flags, $isolated = true ) {
		$code = (string) $code;
		if ( strlen( $code ) > 512000 ) {
			return array( 'ok' => false, 'error' => 'Code exceeds 512 KB limit.' );
		}

		$code = preg_replace( '/^\s*<\?php\s*/i', '', $code );
		$code = preg_replace( '/\?>\s*$/', '', $code );

		if ( empty( $flags['allow_shell'] ) ) {
			foreach ( self::$shell_functions as $fn ) {
				if ( preg_match( '/\b' . preg_quote( $fn, '/' ) . '\s*\(/i', $code ) ) {
					return array( 'ok' => false, 'error' => 'Blocked function: ' . $fn . ' (enable allow_shell to permit).' );
				}
			}
		}

		$start    = microtime( true );
		$output   = '';
		$return   = null;
		$error    = null;
		$fatal    = null;
		$old_time = null;
		$old_mem  = null;

		if ( function_exists( 'set_time_limit' ) ) {
			@set_time_limit( 60 );
		}
		@ini_set( 'display_errors', '0' );

		register_shutdown_function(
			static function () use ( &$fatal ) {
				$err = error_get_last();
				if ( $err && in_array( $err['type'], array( E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR ), true ) ) {
					$fatal = $err['message'] . ' in ' . $err['file'] . ':' . $err['line'];
				}
			}
		);

		ob_start();
		try {
			if ( 'template' === $mode ) {
				// phpcs:ignore Squiz.PHP.Eval.Discouraged
				$return = eval( '?>' . $code );
			} else {
				// phpcs:ignore Squiz.PHP.Eval.Discouraged
				$return = eval( $code );
			}
		} catch ( Throwable $e ) {
			$error = get_class( $e ) . ': ' . $e->getMessage();
		}
		$output = (string) ob_get_clean();

		$result = array(
			'ok'          => null === $error && null === $fatal,
			'output'      => $output,
			'return'      => self::stringify( $return ),
			'error'       => $error,
			'fatal'       => $fatal,
			'duration_ms' => round( ( microtime( true ) - $start ) * 1000, 1 ),
			'memory_peak' => size_format( memory_get_peak_usage( true ) ),
			'wp'          => array(
				'user_id' => get_current_user_id(),
				'is_admin'=> is_admin(),
			),
		);

		if ( $isolated && $result['ok'] ) {
			self::audit( 'php_run', '', array( 'bytes' => strlen( $code ), 'ms' => $result['duration_ms'] ) );
		}

		return $result;
	}

	/**
	 * Make a return value JSON friendly.
	 *
	 * @param mixed $value Value.
	 * @return mixed
	 */
	private static function stringify( $value ) {
		if ( is_object( $value ) ) {
			if ( $value instanceof WP_Post || $value instanceof WP_User || $value instanceof WP_Term ) {
				return $value->to_array();
			}
			if ( $value instanceof WP_Error ) {
				return array(
					'error'   => true,
					'code'    => $value->get_error_code(),
					'message' => $value->get_error_message(),
					'data'    => $value->get_error_data(),
				);
			}
			if ( $value instanceof WP_Query ) {
				return array(
					'found_posts' => $value->found_posts,
					'post_ids'    => wp_list_pluck( $value->posts, 'ID' ),
				);
			}
			return method_exists( $value, 'to_array' ) ? $value->to_array() : get_object_vars( $value );
		}
		if ( is_array( $value ) ) {
			$out = array();
			foreach ( $value as $k => $v ) {
				$out[ $k ] = self::stringify( $v );
			}
			return $out;
		}
		if ( is_resource( $value ) ) {
			return '[resource]';
		}
		if ( is_string( $value ) && strlen( $value ) > 200000 ) {
			return substr( $value, 0, 200000 ) . '…[truncated]';
		}
		return $value;
	}

	/**
	 * Resolve a relative path inside the jail.
	 *
	 * @param string $root Realpath of wp-content.
	 * @param string $path User path.
	 * @return string|WP_Error
	 */
	private static function resolve_path( $root, $path ) {
		$path = str_replace( '\\', '/', (string) $path );
		if ( '' === $path || '/' === $path ) {
			return $root;
		}
		if ( false !== strpos( $path, "\0" ) ) {
			return new WP_Error( 'woodpresser_bad_path', 'Null byte in path.', array( 'status' => 400 ) );
		}
		if ( preg_match( '#(^|/)\.\.(/|$)#', $path ) ) {
			return new WP_Error( 'woodpresser_bad_path', 'Path traversal is not allowed.', array( 'status' => 400 ) );
		}

		$candidate = ( '/' === $path[0] ) ? $path : $root . '/' . $path;
		$candidate = str_replace( '//', '/', $candidate );

		// Walk up to the nearest existing ancestor so that new files and new
		// directories can be created inside the jail. The missing tail is
		// re-attached after the realpath check, so traversal is still caught.
		$probe = $candidate;
		$tail  = '';
		while ( ! file_exists( $probe ) && dirname( $probe ) !== $probe ) {
			$tail = '' === $tail ? basename( $probe ) : basename( $probe ) . '/' . $tail;
			$probe = dirname( $probe );
		}

		$real = realpath( $probe );

		if ( false === $real ) {
			return new WP_Error( 'woodpresser_bad_path', 'Path cannot be resolved.', array( 'status' => 400 ) );
		}

		$real_root = rtrim( str_replace( '\\', '/', $root ), '/' );
		$real_norm = str_replace( '\\', '/', (string) $real );

		if ( $real_norm !== $real_root && 0 !== strpos( $real_norm, $real_root . '/' ) ) {
			return new WP_Error( 'woodpresser_escape', 'Path escapes wp-content.', array( 'status' => 403 ) );
		}

		return '' === $tail ? $real : rtrim( $real_norm, '/' ) . '/' . $tail;
	}

	/**
	 * Copy a file into the bridge backup directory.
	 *
	 * @param string $file Absolute file path.
	 * @return string|null Relative backup path.
	 */
	private static function backup_file( $file ) {
		$dir = WP_CONTENT_DIR . '/woodpresser-backups';
		if ( ! is_dir( $dir ) && ! wp_mkdir_p( $dir ) ) {
			return null;
		}
		$name = gmdate( 'Ymd-His' ) . '-' . substr( md5( $file . microtime() ), 0, 8 ) . '-' . basename( $file );
		$dest = $dir . '/' . $name;
		if ( ! @copy( $file, $dest ) ) {
			return null;
		}
		$all = glob( $dir . '/*' );
		if ( is_array( $all ) && count( $all ) > 40 ) {
			sort( $all );
			foreach ( array_slice( $all, 0, count( $all ) - 40 ) as $old ) {
				@unlink( $old );
			}
		}
		return 'woodpresser-backups/' . $name;
	}

	/**
	 * Detect stacked statements.
	 *
	 * @param string $sql SQL.
	 * @return bool
	 */
	private static function has_multiple_statements( $sql ) {
		$stripped = preg_replace( '/\'(?:\\\\.|[^\'\\\\])*\'|"(?:\\\\.|[^"\\\\])*"|`[^`]*`/', '', $sql );
		$stripped = preg_replace( '/--[^\n]*|#[^\n]*|\/\*.*?\*\//s', '', (string) $stripped );
		$stripped = rtrim( (string) $stripped, " \t\n\r;" );
		return false !== strpos( $stripped, ';' );
	}

	/**
	 * Wrap a payload.
	 *
	 * @param array $payload Payload.
	 * @return WP_REST_Response
	 */
	private static function ok( $payload ) {
		$response = new WP_REST_Response( $payload, 200 );
		$response->header( 'Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0' );
		$response->header( 'X-Woodpresser-Version', WOODPRESSER_BRIDGE_VERSION );
		return $response;
	}

	/**
	 * Truncate a string.
	 *
	 * @param string $value Value.
	 * @param int    $max   Max length.
	 * @return string
	 */
	private static function truncate( $value, $max ) {
		$value = (string) $value;
		return strlen( $value ) > $max ? substr( $value, 0, $max ) . '…' : $value;
	}
}

register_activation_hook( __FILE__, array( 'Woodpresser_Bridge', 'install' ) );
add_action( 'plugins_loaded', array( 'Woodpresser_Bridge', 'init' ) );
