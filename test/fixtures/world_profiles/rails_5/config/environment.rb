require 'rails'
require 'active_record/railtie'
require 'action_controller/railtie'

class UnitbobWorldFixture < Rails::Application
  config.eager_load = false
  config.secret_key_base = 'unitbob-world-profile-fixture'
  config.logger = Logger.new(nil)
end

UnitbobWorldFixture.initialize!
I18n.available_locales = %i[en tr]
ActiveRecord::Base.establish_connection(adapter: 'sqlite3', database: ENV.fetch('UNITBOB_PROFILE_DB'))
connection = ActiveRecord::Base.connection
connection.create_table(:schema_migrations, id: false) { |table| table.string :version, null: false } unless connection.table_exists?(:schema_migrations)
